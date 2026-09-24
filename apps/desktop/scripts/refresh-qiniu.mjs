// Refresh the Qiniu CDN edge cache for the published desktop update objects.
//
// Why this exists: same-version republishes (e.g. a fixed 0.1.7-rc.1 over a
// broken 0.1.7-rc.1) overwrite the same CDN object keys, but edge nodes keep
// serving the previously cached bytes until their TTL expires. The update feed
// then advertises the NEW sha512 while the edge serves OLD bytes, and
// electron-updater fails with "sha512 checksum mismatch". The Qiniu console's
// cache-refresh button fixes one URL at a time; this script does the standard
// set (installer + blockmap + feed + policy) programmatically and waits until
// the refresh tasks report success.
//
// API contract (Qiniu CDN fusion OpenAPI, QBox auth):
//   POST https://fusion.qiniuapi.com/v2/tune/refresh
//     body: {"urls": ["https://..."]}          (max 20 urls per request; 500/day)
//     sign: HmacSHA1("/v2/tune/refresh\n", SK) -> urlsafe-base64
//     auth: Authorization: QBox <AK>:<token>   (JSON body does NOT enter the signature)
//   POST https://fusion.qiniuapi.com/v2/tune/refresh/list
//     body: {"requestId": "..."}               (task states: success/processing/failure)
// Docs: https://developer.qiniu.com/fusion/13367/fusion-api-cache-management
//
// Usage:
//   node refresh-qiniu.mjs <url1> [url2 ...]
// Env:
//   QINIU_ACCESS_KEY   required
//   QINIU_SECRET_KEY   required
//   QINIU_REFRESH_TIMEOUT_MS  optional, default 600000 (10 min; refreshes take 5-10 min)
//   QINIU_REFRESH_POLL_MS     optional, default 15000
// Exit code 0 only when every submitted URL's refresh task reaches "success".

import { createHmac } from 'node:crypto'

const log = (line) => console.log(`qiniu-refresh: ${line}`)
const fail = (line) => { console.error(`qiniu-refresh: ERROR: ${line}`); process.exit(1) }

const ak = process.env.QINIU_ACCESS_KEY
const sk = process.env.QINIU_SECRET_KEY
if (!ak || !sk) fail('QINIU_ACCESS_KEY and QINIU_SECRET_KEY are required')

const timeoutMs = Number(process.env.QINIU_REFRESH_TIMEOUT_MS ?? 600_000)
const pollMs = Number(process.env.QINIU_REFRESH_POLL_MS ?? 15_000)
const apiHost = 'fusion.qiniuapi.com'

const urls = process.argv.slice(2).filter((u) => u && u.startsWith('https://'))
if (urls.length === 0) fail('pass at least one full https:// URL as a CLI argument')

const urlsafeBase64 = (buf) =>
  Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_')

// QBox auth: signature covers ONLY "path(+query)\n" — the JSON body is excluded.
const qboxToken = (path) => {
  const sign = createHmac('sha1', sk).update(`${path}\n`).digest()
  return `QBox ${ak}:${urlsafeBase64(sign)}`
}

const postJson = async (path, body) => {
  const res = await fetch(`https://${apiHost}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: qboxToken(path) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { fail(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`) }
  if (res.status === 401 || (json.code && (json.code === 401001 || json.code === 401002))) {
    fail(`auth rejected (HTTP ${res.status}, code ${json.code}): ${json.error ?? text.slice(0, 200)} — check QINIU_ACCESS_KEY/QINIU_SECRET_KEY`)
  }
  return { status: res.status, json }
}

const refreshPath = '/v2/tune/refresh'
const listPath = '/v2/tune/refresh/list'

// Submit in batches of 20 (per-request limit), collecting requestIds.
const requestIds = []
const orphanUrls = []
for (let i = 0; i < urls.length; i += 20) {
  const batch = urls.slice(i, i + 20)
  const { status, json } = await postJson(refreshPath, { urls: batch })
  if (status !== 200 || json.code !== 200) {
    const known = {
      400031: 'invalid url (must be a full http/https URL)',
      400032: 'invalid host (domain not attached to CDN)',
      400034: 'daily URL refresh quota exhausted (500/day, resets at midnight)',
      400037: 'url already refreshing (treated as accepted)',
    }
    if (json.code === 400037) { log(`batch ${i / 20 + 1}: already refreshing, will poll by url`); orphanUrls.push(...batch); continue }
    fail(`refresh rejected (HTTP ${status}, code ${json.code}: ${known[json.code] ?? json.error}): ${JSON.stringify(json).slice(0, 400)}`)
  }
  log(`batch ${i / 20 + 1}: accepted ${batch.length} url(s), requestId=${json.requestId}, urlSurplusDay=${json.urlSurplusDay ?? '?'}`)
  if (json.invalidUrls?.length) log(`invalidUrls: ${json.invalidUrls.join(', ')}`)
  if (json.requestId) requestIds.push(json.requestId)
}

// Poll refresh/list until every task reaches a terminal state.
const deadline = Date.now() + timeoutMs
const pending = new Set(urls)
const failed = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (;;) {
  const rows = []
  for (const requestId of requestIds) {
    const { status, json } = await postJson(listPath, { requestId })
    if (status !== 200 || json.code !== 200) { log(`list query hiccup (HTTP ${status}, code ${json.code}); retrying`); continue }
    for (const item of json.items ?? []) rows.push(item)
  }
  for (let i = 0; i < orphanUrls.length; i += 20) {
    const batch = orphanUrls.slice(i, i + 20)
    const { status, json } = await postJson(listPath, { urls: batch })
    if (status !== 200 || json.code !== 200) { log(`list query hiccup (HTTP ${status}, code ${json.code}); retrying`); continue }
    for (const item of json.items ?? []) rows.push(item)
  }
  for (const item of rows) {
    if (item.state === 'success') pending.delete(item.url)
    else if (item.state === 'failure') failed.push(`${item.url} (${item.stateDetail || 'no detail'})`)
  }
  if (failed.length > 0) fail(`refresh task(s) failed: ${failed.join('; ')}`)
  if (pending.size === 0) { log(`all ${urls.length} url(s) refreshed OK`); process.exit(0) }
  if (Date.now() > deadline) fail(`timeout after ${Math.round(timeoutMs / 1000)}s; still processing: ${[...pending].join(', ')} — re-run the refresh workflow later (or check 控制台 > 缓存刷新记录)`)
  log(`waiting: ${pending.size} url(s) still processing`)
  await sleep(pollMs)
}
