/**
 * Publish the unsigned win-x64 desktop build as an electron-updater feed on Qiniu (Kodo + CDN).
 *
 * Objects published under the bound CDN host:
 *   dsh-desk/bin/win-x64/deepseek-harness-<version>-win-x64.exe        NSIS installer
 *   dsh-desk/bin/win-x64/deepseek-harness-<version>-win-x64.exe.blockmap  differential blockmap (when present)
 *   dsh-desk/feeds/win-x64/nightly.yml                                 channel metadata (absolute URLs)
 *   api/v0/check_client_update                                         mandatory-update policy (static, no force)
 *
 * This script uploads only — it does NOT refresh the CDN edge cache. A same-version republish
 * overwrites the same object keys, and edges keep serving the OLD cached bytes until refreshed,
 * which makes electron-updater fail with "sha512 checksum mismatch" (feed says new hash, edge
 * serves old file). After any same-key overwrite, run the "Refresh Qiniu CDN cache" workflow
 * (.github/workflows/refresh-qiniu-cdn.yml, Qiniu fusion API /v2/tune/refresh) or
 * `node apps/desktop/scripts/refresh-qiniu.mjs <urls>` with the QINIU_ACCESS_KEY / QINIU_SECRET_KEY
 * credentials (policy changed 2026-09-24: API refresh is allowed; original upload-only decision
 * was 2026-09-22).
 *
 * Environment: QINIU_ACCESS_KEY, QINIU_SECRET_KEY, QINIU_BUCKET, QINIU_CDN_HOST (bare https host),
 * optional QINIU_ZONE (z0|z1|z2|na0|as0, default z0).
 *
 * Qualification modes (the objects a prior full publish left in place are assumed correct
 * unless explicitly re-uploaded):
 *   QINIU_UPLOAD_SCOPE=feed  — upload only nightly.yml + the policy object.
 *     The yml version may be overridden with QINIU_FEED_VERSION (empty = package version,
 *     i.e. restore the honest feed after a test). QINIU_FEED_SHA512 (base64) and
 *     QINIU_FEED_SIZE (bytes) must describe the binary the feed points at. QINIU_FEED_URL_OVERRIDE
 *     (absolute https URL) may redirect the feed to a differently keyed binary (fresh CDN key =
 *     no stale edge cache); or QINIU_FEED_URL_KEY_NAME (key base name without .exe) constructs
 *     the URL under the standard bin prefix of the configured CDN host.
 *     The first positional argument may be `-` (artifacts are not read).
 *   QINIU_UPLOAD_SCOPE=bin   — upload only the installer + blockmap, optionally under a custom
 *     key name (QINIU_BIN_NAME, without .exe) so the object is a fresh CDN key.
 *
 * Usage: node publish-qiniu.mjs <unsigned-artifacts-dir|-> <node-modules-dir-with-qiniu>
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeQiniuCdnHost } from './qiniu-host.mjs'
import { parallelPut } from './parallel-upload-qiniu.mjs'

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
  fail('usage: node publish-qiniu.mjs <unsigned-artifacts-dir|-> <node-modules-dir-with-qiniu>')
}
const uploadScope = (env.QINIU_UPLOAD_SCOPE?.trim() || 'all').toLowerCase()
if (uploadScope !== 'all' && uploadScope !== 'feed' && uploadScope !== 'bin') {
  fail(`QINIU_UPLOAD_SCOPE must be "all", "feed", or "bin"; got "${env.QINIU_UPLOAD_SCOPE}"`)
}
const feedOnly = uploadScope === 'feed'
const binOnly = uploadScope === 'bin'
if (feedOnly && artifactsDir === '-') {
  console.log('publish-qiniu: qualification mode — feed + policy objects only, no binaries')
}
if (binOnly) {
  if (artifactsDir === '-') fail('QINIU_UPLOAD_SCOPE=bin requires the unsigned-artifacts directory (not "-")')
  console.log('publish-qiniu: qualification mode — binary objects only, no feed')
}
// Resolve the qiniu SDK from the workflow-provisioned module dir; the repo tree is left untouched.
const requireQiniu = createRequire(join(qiniuModuleDir, 'noop.js'))
const qiniu = requireQiniu('qiniu')

const dshVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version
const desktopVersion = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version
if (dshVersion !== desktopVersion) {
  fail(`desktop version ${desktopVersion} does not match dsh version ${dshVersion}; bump both or fix the mismatch`)
}

// bin scope may publish the build under a custom key name (fresh CDN key = never a stale overwrite).
const binNameBase = binOnly && env.QINIU_BIN_NAME?.trim()
  ? env.QINIU_BIN_NAME.trim()
  : `deepseek-harness-${dshVersion}-win-x64`
const exeName = `${binNameBase}.exe`

async function sha512Base64File(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

let exeSha512
let exeSize
let blockmapExists = false
let ymlVersion = dshVersion
let exePath
let blockmapPath
if (feedOnly) {
  const override = env.QINIU_FEED_VERSION?.trim()
  ymlVersion = override === '' ? dshVersion : override
  if (override !== '' && !/^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(ymlVersion)) {
    fail(`QINIU_FEED_VERSION does not look like a version: "${override}"`)
  }
  exeSha512 = env.QINIU_FEED_SHA512?.trim()
  if (!/^[A-Za-z0-9+/]{86}==$/.test(exeSha512 ?? '')) {
    fail('QINIU_FEED_SHA512 must be the 88-character base64 SHA-512 of the binary the full publish already uploaded')
  }
  exeSize = Number(env.QINIU_FEED_SIZE?.trim())
  if (!Number.isSafeInteger(exeSize) || exeSize <= 0) fail('QINIU_FEED_SIZE must be a positive integer byte count')
  if (ymlVersion !== dshVersion) {
    console.log(`publish-qiniu: WARNING — writing TEST feed version ${ymlVersion} (package version is ${dshVersion}); restore with an empty QINIU_FEED_VERSION`)
  }
} else {
  // Since 0.1.7 upstream names the unsigned NSIS installer with an "-unsigned"
  // suffix locally; the update channel keeps the standard object key (the feed
  // yml is the single source of truth for the URL, and the blockmap is derived
  // from that URL by the client).
  let localExeName = exeName
  let candidatePath = join(artifactsDir, localExeName)
  let exeStat = await stat(candidatePath).catch(() => undefined)
  if (exeStat === undefined || exeStat.size === 0) {
    localExeName = exeName.replace(/\.exe$/u, '-unsigned.exe')
    candidatePath = join(artifactsDir, localExeName)
    exeStat = await stat(candidatePath).catch(() => undefined)
  }
  if (exeStat === undefined || exeStat.size === 0) fail(`missing or empty artifact ${candidatePath}`)
  exePath = candidatePath
  blockmapPath = join(artifactsDir, `${localExeName}.blockmap`)
  blockmapExists = (await stat(blockmapPath).catch(() => undefined))?.isFile() ?? false
  exeSha512 = await sha512Base64File(exePath)
  exeSize = exeStat.size
  console.log(`publish-qiniu: ${localExeName} (published as ${exeName}) size=${exeSize} sha512=${exeSha512.slice(0, 16)}…`)
}

const feedUrlOverride = env.QINIU_FEED_URL_OVERRIDE?.trim()
if (feedUrlOverride && !feedUrlOverride.startsWith('https://')) {
  fail(`QINIU_FEED_URL_OVERRIDE must be an absolute https URL; got "${feedUrlOverride}"`)
}
const feedUrlKeyName = env.QINIU_FEED_URL_KEY_NAME?.trim()
if (feedUrlOverride) {
  if (!feedOnly) fail('QINIU_FEED_URL_OVERRIDE is only honored in QINIU_UPLOAD_SCOPE=feed')
} else if (feedUrlKeyName) {
  if (!feedOnly) fail('QINIU_FEED_URL_KEY_NAME is only honored in QINIU_UPLOAD_SCOPE=feed')
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(feedUrlKeyName)) fail(`QINIU_FEED_URL_KEY_NAME must be a plain key base name (letters, digits, dots, dashes); got "${feedUrlKeyName}"`)
}
const exeUrl = feedOnly && (feedUrlOverride || feedUrlKeyName)
  ? feedUrlOverride ?? `https://${host}/${BIN_PREFIX}/${feedUrlKeyName}-win-x64.exe`
  : `https://${host}/${BIN_PREFIX}/${exeName}`

const work = await mkdtemp(join(tmpdir(), 'dsh-publish-qiniu-'))
let ymlPath
if (!binOnly) {
  const yml = [
    `version: ${ymlVersion}`,
    'files:',
    `  - url: ${exeUrl}`,
    `    size: ${exeSize}`,
    `    sha512: ${exeSha512}`,
    `path: ${exeUrl}`,
    `sha512: ${exeSha512}`,
    `releaseDate: ${new Date().toISOString()}`,
    '',
  ].join('\n')
  console.log(`publish-qiniu: nightly.yml for ${ymlVersion}:\n${yml}`)
  ymlPath = join(work, 'nightly.yml')
  await writeFile(ymlPath, yml)
}
const policyPath = join(work, 'check_client_update.json')
await writeFile(policyPath, `${POLICY_BODY}\n`)

const mac = new qiniu.auth.digest.Mac(accessKey, secretKey)
const conf = new qiniu.conf.Config({ useHttpsDomain: true, zone: qiniu.zone[zoneConst] })
const formUploader = new qiniu.form_up.FormUploader(conf)
// Installers (~300MB) from an overseas runner to Qiniu: a single form POST times out at
// 600s and the SDK's resumable uploader crawls (sequential 4MB blocks never finished a
// 60-minute job). Upload large objects with concurrent mkblk/mkfile multipart, falling
// back to the SDK resumable uploader if that fails.
const resumeUploader = new qiniu.resume_up.ResumeUploader(conf)
const PARALLEL_THRESHOLD = 32 * 1024 * 1024

async function putObject(key, localFile, mimeType) {
  const policy = new qiniu.rs.PutPolicy({ scope: `${bucket}:${key}`, expires: 3600 })
  const token = policy.uploadToken(mac)
  const size = (await stat(localFile)).size
  if (size >= PARALLEL_THRESHOLD) {
    try {
      console.log(`publish-qiniu: parallel multipart upload ${key} (${size} bytes)`)
      await parallelPut({ file: localFile, key, bucket, zone: zoneName, mimeType, qiniu, accessKey, secretKey })
      console.log(`publish-qiniu: uploaded ${key}`)
      return
    } catch (err) {
      console.warn(`publish-qiniu: parallel upload failed (${String(err.message).slice(0, 200)}); falling back to SDK resumable uploader`)
    }
    const extraResume = new qiniu.resume_up.PutExtra()
    extraResume.mimeType = mimeType
    const resultResume = await resumeUploader.putFile(token, key, localFile, extraResume)
    const statusResume = resultResume?.resp?.statusCode
    if (statusResume === undefined || statusResume >= 400) {
      fail(`upload ${key} failed: HTTP ${statusResume} ${JSON.stringify(resultResume?.data ?? resultResume)}`)
    }
    console.log(`publish-qiniu: uploaded ${key}`)
    return
  }
  const extra = new qiniu.form_up.PutExtra()
  extra.mimeType = mimeType
  const result = await formUploader.putFile(token, key, localFile, extra)
  const status = result?.resp?.statusCode
  if (status === undefined || status >= 400) {
    fail(`upload ${key} failed: HTTP ${status} ${JSON.stringify(result?.data ?? result)}`)
  }
  console.log(`publish-qiniu: uploaded ${key}`)
}

if (!feedOnly) {
  await putObject(`${BIN_PREFIX}/${exeName}`, exePath, 'application/vnd.microsoft.portable-executable')
  if (blockmapExists) await putObject(`${BIN_PREFIX}/${exeName}.blockmap`, blockmapPath, 'application/octet-stream')
}
if (!binOnly) {
  await putObject(FEED_KEY, ymlPath, 'application/yaml')
  await putObject(POLICY_KEY, policyPath, 'application/json')
  console.log(`publish-qiniu: done; feed https://${host}/${FEED_KEY}`)
} else {
  console.log(`publish-qiniu: done; binary https://${host}/${BIN_PREFIX}/${exeName}`)
}
