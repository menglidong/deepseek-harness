/**
 * Publish the unsigned win-x64 desktop build as an electron-updater feed on Qiniu (Kodo + CDN).
 *
 * Objects published under the bound CDN host:
 *   dsh-desk/bin/win-x64/deepseek-harness-<version>-win-x64.exe        NSIS installer
 *   dsh-desk/bin/win-x64/deepseek-harness-<version>-win-x64.exe.blockmap  differential blockmap (when present)
 *   dsh-desk/feeds/win-x64/nightly.yml                                 channel metadata (absolute URLs)
 *   api/v0/check_client_update                                         mandatory-update policy (static, no force)
 *
 * After the uploads, the feed and policy URLs are refreshed at the CDN edge so clients see the new
 * metadata immediately (same-key overwrites would otherwise be served from cache).
 *
 * Environment: QINIU_ACCESS_KEY, QINIU_SECRET_KEY, QINIU_BUCKET, QINIU_CDN_HOST (bare https host),
 * optional QINIU_ZONE (z0|z1|z2|na0|as0, default z0).
 *
 * Usage: node publish-qiniu.mjs <unsigned-artifacts-dir> <node-modules-dir-with-qiniu>
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeQiniuCdnHost } from './qiniu-host.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = join(scriptDir, '..')
const repoRoot = join(appRoot, '..', '..')

const BIN_PREFIX = 'dsh-desk/bin/win-x64'
const FEED_KEY = 'dsh-desk/feeds/win-x64/nightly.yml'
const POLICY_KEY = 'api/v0/check_client_update'
const POLICY_BODY = JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: null } })
const ZONES = { z0: 'Zone_z0', z1: 'Zone_z1', z2: 'Zone_z2', na0: 'Zone_na0', as0: 'Zone_as0' }

function fail(message) {
  console.error(`publish-qiniu: ${message}`)
  process.exit(1)
}

const env = process.env
for (const name of ['QINIU_ACCESS_KEY', 'QINIU_SECRET_KEY', 'QINIU_BUCKET', 'QINIU_CDN_HOST']) {
  if (env[name]?.trim() === '') fail(`${name} must be set to a non-empty value`)
}
const accessKey = env.QINIU_ACCESS_KEY.trim()
const secretKey = env.QINIU_SECRET_KEY.trim()
const bucket = env.QINIU_BUCKET.trim()
const host = normalizeQiniuCdnHost(env.QINIU_CDN_HOST)
if (host === undefined) fail(`QINIU_CDN_HOST must be a bare host name (an https:// prefix and trailing slash are tolerated, a path is not), got "${env.QINIU_CDN_HOST}"`)
const zoneName = (env.QINIU_ZONE?.trim() || 'z0').toLowerCase()
const zoneConst = ZONES[zoneName]
if (zoneConst === undefined) fail(`QINIU_ZONE must be one of ${Object.keys(ZONES).join(', ')}; got "${env.QINIU_ZONE}"`)

const artifactsDir = process.argv[2]
const qiniuModuleDir = process.argv[3]
if (artifactsDir === undefined || qiniuModuleDir === undefined) {
  fail('usage: node publish-qiniu.mjs <unsigned-artifacts-dir> <node-modules-dir-with-qiniu>')
}
// Resolve the qiniu SDK from the workflow-provisioned module dir; the repo tree is left untouched.
const requireQiniu = createRequire(join(qiniuModuleDir, 'noop.js'))
const qiniu = requireQiniu('qiniu')

const dshVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version
const desktopVersion = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version
if (dshVersion !== desktopVersion) {
  fail(`desktop version ${desktopVersion} does not match dsh version ${dshVersion}; bump both or fix the mismatch`)
}

const exeName = `deepseek-harness-${dshVersion}-win-x64.exe`
const exePath = join(artifactsDir, exeName)
const exeStat = await stat(exePath).catch(() => undefined)
if (exeStat === undefined || exeStat.size === 0) fail(`missing or empty artifact ${exePath}`)
const blockmapPath = join(artifactsDir, `${exeName}.blockmap`)
const blockmapExists = (await stat(blockmapPath).catch(() => undefined))?.isFile() ?? false

async function sha512Base64File(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}
const exeSha512 = await sha512Base64File(exePath)
console.log(`publish-qiniu: ${exeName} size=${exeStat.size} sha512=${exeSha512.slice(0, 16)}…`)

const exeUrl = `https://${host}/${BIN_PREFIX}/${exeName}`
const yml = [
  `version: ${dshVersion}`,
  'files:',
  `  - url: ${exeUrl}`,
  `    size: ${exeStat.size}`,
  `    sha512: ${exeSha512}`,
  `path: ${exeUrl}`,
  `sha512: ${exeSha512}`,
  `releaseDate: ${new Date().toISOString()}`,
  '',
].join('\n')
console.log(`publish-qiniu: nightly.yml for ${dshVersion}:\n${yml}`)

const work = await mkdtemp(join(tmpdir(), 'dsh-publish-qiniu-'))
const ymlPath = join(work, 'nightly.yml')
await writeFile(ymlPath, yml)
const policyPath = join(work, 'check_client_update.json')
await writeFile(policyPath, `${POLICY_BODY}\n`)

const mac = new qiniu.auth.digest.Mac(accessKey, secretKey)
const conf = new qiniu.conf.Config({ useHttpsDomain: true, zone: qiniu.zone[zoneConst] })
const uploader = new qiniu.form_up.FormUploader(conf)

async function putObject(key, localFile, mimeType) {
  const policy = new qiniu.rs.PutPolicy({ scope: `${bucket}:${key}`, expires: 3600 })
  const token = policy.uploadToken(mac)
  const extra = new qiniu.form_up.PutExtra()
  extra.mimeType = mimeType
  const result = await uploader.putFile(token, key, localFile, extra)
  const status = result?.resp?.statusCode
  if (status === undefined || status >= 400) {
    fail(`upload ${key} failed: HTTP ${status} ${JSON.stringify(result?.data ?? result)}`)
  }
  console.log(`publish-qiniu: uploaded ${key}`)
}

await putObject(`${BIN_PREFIX}/${exeName}`, exePath, 'application/vnd.microsoft.portable-executable')
if (blockmapExists) await putObject(`${BIN_PREFIX}/${exeName}.blockmap`, blockmapPath, 'application/octet-stream')
await putObject(FEED_KEY, ymlPath, 'application/yaml')
await putObject(POLICY_KEY, policyPath, 'application/json')

// Refresh the edge cache for the mutable metadata so the same-key overwrite is visible immediately.
const refreshed = [
  `https://${host}/${FEED_KEY}`,
  `https://${host}/${POLICY_KEY}`,
  ...(blockmapExists ? [`https://${host}/${BIN_PREFIX}/${exeName}.blockmap`] : []),
]
await new Promise((resolve, reject) => {
  new qiniu.cdn.CdnManager(mac).refreshUrls(refreshed, (error, body) => (error ? reject(error) : resolve(body)))
}).then(
  (body) => console.log(`publish-qiniu: CDN refresh accepted (${JSON.stringify(body ?? {})})`),
  (error) => fail(`CDN refresh failed: ${error instanceof Error ? error.message : String(error)}`),
)

console.log(`publish-qiniu: done; feed https://${host}/${FEED_KEY}`)
