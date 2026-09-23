/**
 * Parallel multipart (mkblk/mkfile) upload to Qiniu Kodo for large objects.
 *
 * Why: on the slow cross-region GitHub-runner -> Qiniu link, a single form POST
 * of the ~300MB NSIS installer hits the 600s response timeout, and the SDK's
 * resumable uploader sends its 4MB blocks SEQUENTIALLY (a full hour of crawling
 * without finishing). This module splits the object into 4MB blocks, uploads
 * them with N concurrent mkblk requests (per-block retries, CRC32-verified),
 * then assembles the object with a single mkfile call.
 *
 * Protocol (Qiniu resumable upload v1, same calls the qiniu-node SDK makes):
 *   POST {upDomain}/mkblk/{blockSize}          Authorization: UpToken <token>
 *        body: raw block bytes  ->  200 {crc32:<int>, ctx:"...", ...}
 *   POST {upDomain}/mkfile/{fileSize}/{urlsafeB64(key)}/{urlsafeB64(mimeType)}
 *        body: "ctx0,ctx1,...,ctxN-1" (file order)  ->  200 {hash, key}
 *
 * As a module:  import { parallelPut } from './parallel-upload-qiniu.mjs'
 * As a CLI:     node parallel-upload-qiniu.mjs <file> <object-key> <qiniu-module-dir> [mimeType]
 *   with env QINIU_ACCESS_KEY, QINIU_SECRET_KEY, QINIU_BUCKET, QINIU_ZONE (z0|z1|z2, default z2),
 *   QINIU_UPLOAD_CONCURRENCY (default 16).
 */
import { createRequire } from 'node:module'
import { open, stat } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BLOCK_SIZE = 4 * 1024 * 1024
const BLOCK_TIMEOUT_MS = 180_000
const BLOCK_RETRIES = 4

const UP_HOSTS = {
  z0: 'upload.qiniup.com',
  z1: 'upload-z1.qiniup.com',
  z2: 'upload-z2.qiniup.com',
  na0: 'upload-na0.qiniup.com',
  as0: 'upload-as0.qiniup.com',
}

function urlsafeB64(str) {
  // Identical to the SDK's util.urlsafeBase64Encode: replace URL-unsafe chars, KEEP padding.
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}

function backoffMs(attempt) {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500)
}

async function postJson(url, body, headers) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BLOCK_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text } }
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Upload `file` to `key` in bucket via concurrent mkblk + mkfile.
 * @param {object} opts
 * @param {string} opts.file local path
 * @param {string} opts.key object key (bucket-relative)
 * @param {string} opts.bucket bucket name
 * @param {string} opts.zone z0|z1|z2|na0|as0
 * @param {string} opts.mimeType
 * @param {any} opts.qiniu the required 'qiniu' module (for Mac/PutPolicy)
 * @param {string} opts.accessKey
 * @param {string} opts.secretKey
 * @param {number} [opts.concurrency=16]
 * @param {string} [opts.upDomain] override the upload host (tests)
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 */
export async function parallelPut({
  file, key, bucket, zone, mimeType, qiniu, accessKey, secretKey,
  concurrency = 16, upDomain, onProgress = () => {},
}) {
  upDomain = upDomain ?? `https://${UP_HOSTS[zone] ?? UP_HOSTS.z2}`
  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey)
  const policy = new qiniu.rs.PutPolicy({ scope: `${bucket}:${key}`, expires: 3600 })
  const token = policy.uploadToken(mac)
  const headers = {
    Authorization: `UpToken ${token}`,
    'Content-Type': 'application/octet-stream',
  }

  const { size } = await stat(file)
  const total = Math.max(1, Math.ceil(size / BLOCK_SIZE))
  const parts = new Array(total)
  let done = 0
  let next = 0
  const t0 = Date.now()

  const fd = await open(file, 'r')
  try {
    async function uploadBlock(idx) {
      const len = Math.min(BLOCK_SIZE, size - idx * BLOCK_SIZE)
      const buf = Buffer.alloc(len)
      await fd.read(buf, 0, len, idx * BLOCK_SIZE)
      const localCrc = crc32(buf) >>> 0
      const url = `${upDomain}/mkblk/${len}`
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, backoffMs(attempt - 1)))
        try {
          const { status, json } = await postJson(url, buf, headers)
          if (status === 200 && Number(json.crc32) === localCrc) {
            parts[idx] = json.ctx
            done += 1
            onProgress(done, total)
            return
          }
          throw new Error(`HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`)
        } catch (err) {
          if (attempt + 1 >= BLOCK_RETRIES) throw new Error(`block ${idx} failed after ${BLOCK_RETRIES} attempts: ${err.message}`)
        }
      }
    }

    // worker pool over block indices
    async function worker() {
      for (;;) {
        const idx = next
        next += 1
        if (idx >= total) return
        await uploadBlock(idx)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
    await Promise.all(workers)

    // assemble — the SDK's mkfile URL shape: literal "/key/" and "/mimeType/" segments.
    // Without them the service treats the encoded key as a literal object name and
    // rejects the assembly with 403 "key doesn't match with scope".
    const mkfileUrl = `${upDomain}/mkfile/${size}/key/${urlsafeB64(key)}/mimeType/${urlsafeB64(mimeType)}`
    let mk
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, backoffMs(attempt - 1)))
      try {
        const { status, json } = await postJson(mkfileUrl, parts.join(','), headers)
        if (status === 200) { mk = json; break }
        throw new Error(`HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`)
      } catch (err) {
        if (attempt + 1 >= BLOCK_RETRIES) throw new Error(`mkfile failed after ${BLOCK_RETRIES} attempts: ${err.message}`)
      }
    }
    if (mk.key !== key) throw new Error(`mkfile returned key ${JSON.stringify(mk.key)}, expected ${key}`)
    const secs = Math.round((Date.now() - t0) / 100)
    console.log(`parallel-upload: ${key} ${size} bytes in ${total} blocks (${secs}s, hash=${mk.hash})`)
  } finally {
    await fd.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, key, modDir] = process.argv.slice(2)
  if (!file || !key || !modDir) {
    console.error('usage: node parallel-upload-qiniu.mjs <file> <object-key> <qiniu-module-dir> [mimeType]')
    process.exit(2)
  }
  const requireQiniu = createRequire(join(modDir, 'noop.js'))
  const qiniu = requireQiniu('qiniu')
  const mimeType = process.argv[5] ?? 'application/octet-stream'
  const zone = process.env.QINIU_ZONE?.trim() || 'z2'
  await parallelPut({
    file,
    key,
    bucket: process.env.QINIU_BUCKET,
    zone,
    mimeType,
    qiniu,
    accessKey: process.env.QINIU_ACCESS_KEY,
    secretKey: process.env.QINIU_SECRET_KEY,
    concurrency: Number(process.env.QINIU_UPLOAD_CONCURRENCY?.trim() || 16),
    onProgress: (d, t) => { if (d % 10 === 0 || d === t) console.log(`parallel-upload: ${d}/${t} blocks`) },
  })
}
