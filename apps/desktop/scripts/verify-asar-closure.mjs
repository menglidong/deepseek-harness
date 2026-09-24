// Verify that the packaged shell's import closure is complete inside app.asar.
//
// Background (2026-09-24, 0.1.7-rc.1 field failures): the asar root node_modules
// is collected by electron-builder from the desktop package's PRODUCTION
// dependency closure only (dependencies, not devDependencies and not
// peerDependencies). Upstream 0.1.7 shipped the shell with runtime imports that
// were undeclared (devDependency) or whose runtime peers were never declared, so
// every packaged build crashed at startup with
//   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/...'
// The bug only showed up on real machines because the packaged smoke test
// exercises the dsh host runtime (dsh/node_modules), not the shell main process.
//
// This gate runs after packaging, before publish: it opens resources/app.asar,
// extracts every bare module specifier from lib/main.js and lib/preload-*.cjs,
// and fails the build if (a) the package is absent from the asar root
// node_modules, or (b) the resolved entry file (main / exports map / subpath)
// does not exist inside the asar. A green gate means the shell process can at
// least resolve its full static import graph at startup.
//
// The asar is read directly (JSON header + blob offsets), not through the
// @electron/asar API: the statFile/extractFile helpers in current releases
// fail on nested node_modules paths. asar format: 16-byte pickle prefix, then
// the UTF-8 header JSON (4-byte aligned); every file node carries
// { size, offset } relative to the start of the archive.
//
// Usage:
//   node verify-asar-closure.mjs <win-unpacked dir>
//
// The expected app version is read from apps/desktop/package.json (this file
// lives in apps/desktop/scripts/) and must match the asar's package.json.

import { readFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'

const log = (line) => console.log(`asar-closure: ${line}`)
const fail = (lines) => { for (const l of lines) console.error(`asar-closure: ERROR: ${l}`); process.exit(1) }

const unpacked = process.argv[2]
if (!unpacked || !existsSync(unpacked)) fail([`usage: node verify-asar-closure.mjs <win-unpacked dir> (missing or not a directory: ${unpacked})`])

const asarPath = join(unpacked, 'resources', 'app.asar')
if (!existsSync(asarPath)) fail([`app.asar not found at ${asarPath}`])
const unpackedRoot = join(unpacked, 'resources', 'app.asar.unpacked')

// --- read the asar header directly ------------------------------------------
const raw = readFileSync(asarPath)
// asar pickle layout: [0:4]=4, [4:8]=payload size, [8:12]=4, [12:16]=header string size
const headerStringSize = raw.readUInt32LE(12)
if (headerStringSize < 64 || headerStringSize > raw.length) fail(['asar header size looks wrong — is this really an asar file?'])
const header = JSON.parse(raw.slice(16, 16 + headerStringSize).toString('utf8'))
// File blobs start after the 4-byte-aligned header; node.offset values are
// relative to dataStart (verified against a real packaged asar, 2026-09-24).
const dataStart = 16 + headerStringSize + ((4 - (16 + headerStringSize) % 4) % 4)

// Walk the header tree to a relative path; returns the node or undefined.
const findNode = (rel) => {
  let node = header
  for (const seg of rel.split('/')) {
    if (!node || !node.files || !(seg in node.files)) return undefined
    node = node.files[seg]
  }
  return node
}
// A node is a stored file ({size, offset}), an unpacked file ({unpacked:true}),
// or a symlink ({link}). Missing nodes are undefined.
const fileExists = (rel) => {
  const node = findNode(rel)
  if (!node) return false
  if (node.unpacked) return existsSync(join(unpackedRoot, rel))
  if (node.link) return true // symlink nodes count as present
  return typeof node.size === 'number'
}
const readFile = (rel) => {
  const node = findNode(rel)
  if (!node) throw new Error(`not in asar: ${rel}`)
  if (node.unpacked) return readFileSync(join(unpackedRoot, rel), 'utf8')
  if (typeof node.size !== 'number') throw new Error(`not a file node: ${rel}`)
  const fd = openSync(asarPath)
  try {
    const buf = Buffer.alloc(node.size)
    readSync(fd, buf, 0, node.size, dataStart + Number(node.offset))
    return buf.toString('utf8')
  } finally { closeSync(fd) }
}
const dirList = (rel) => {
  const node = findNode(rel)
  if (!node || !node.files) return undefined
  return Object.keys(node.files)
}

// --- inventory of the asar root node_modules ---------------------------------
const topNames = dirList('node_modules')
if (!topNames) fail(['asar root has no node_modules directory'])
const packages = new Set()
for (const name of topNames) {
  if (name.startsWith('@')) {
    const scoped = dirList(`node_modules/${name}`)
    if (scoped) for (const sub of scoped) packages.add(`${name}/${sub}`)
  } else {
    packages.add(name)
  }
}
log(`asar: ${packages.size} packages in root node_modules`)

// --- sanity: entry files exist and the version matches ------------------------
const problems = []
for (const rel of ['package.json', 'lib/main.js']) {
  if (!fileExists(rel)) problems.push(`asar is missing ${rel}`)
}
if (problems.length === 0) {
  const asarPkg = JSON.parse(readFile('package.json'))
  const expected = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  if (asarPkg.version !== expected.version) problems.push(`version mismatch: asar=${asarPkg.version} expected=${expected.version}`)
  else log(`version: ${asarPkg.version} OK`)
}

// --- walk the shell's full transitive import graph -----------------------------
// Seed from the shell entry files and follow every bare and relative import,
// resolving each against the asar. A bare specifier whose package is absent
// from the asar root node_modules (or whose entry file is absent) is exactly
// what produces ERR_MODULE_NOT_FOUND at startup — both directly (from
// lib/main.js, the 2026-09-24 devDependency bug) and transitively (from a
// closure package's own requires, the undeclared-peerDependency bug).
const specRe = [
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                    // dynamic import()
  /\bfrom\s+['"]([^'"]+)['"]/g,                              // static import ... from
  /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,                   // side-effect import "x"
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                 // CJS require
]
const pkgNameOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])
const subpathOf = (s) => { const n = pkgNameOf(s); return s.slice(n.length).replace(/^\//, '') }
// Packages intentionally absent: optional native peers of ws (ws falls back
// to pure JS) and supports-color (debug's require is wrapped in try/catch;
// absence degrades color detection, never crashes).
const OPTIONAL_PKGS = new Set(['bufferutil', 'utf-8-validate', 'supports-color'])
const NODE_BUILTINS = new Set(builtinModules)

const libNames = dirList('lib') || []
const libFiles = libNames.filter((f) => f === 'main.js' || /^preload-[^/]+\.cjs$/.test(f)).sort().map((f) => `lib/${f}`)
if (!libFiles.includes('lib/main.js')) fail(['asar is missing lib/main.js'])
log(`shell entry files: ${libFiles.join(', ')}`)

// bare specifier -> asar-relative entry file (or null when unresolvable)
const entryCache = new Map()
const resolveBare = (spec) => {
  if (entryCache.has(spec)) return entryCache.get(spec)
  let rel = null
  const pkg = pkgNameOf(spec)
  const sub = subpathOf(spec)
  if (fileExists(`node_modules/${pkg}/package.json`)) {
    const pj = JSON.parse(readFile(`node_modules/${pkg}/package.json`))
    const pick = (v) => (typeof v === 'string' ? v : v && (v.default ?? v.import ?? v.node ?? v.require))
    const exp = pj.exports ? (sub ? (pj.exports[sub] ?? pj.exports[`./${sub}`]) : pj.exports['.']) : undefined
    let entry = pick(exp) ?? (sub ? null : (pj.main ?? 'index.js'))
    if (!entry && sub) entry = sub // no exports map: literal path
    if (entry) {
      const clean = entry.replace(/^\.\//, '')
      const cands = [clean, `${clean}.js`, `${clean}.cjs`, `${clean}.mjs`, `${clean}.json`, `${clean}/index.js`]
      const hit = cands.find((c) => fileExists(`node_modules/${pkg}/${c}`))
      if (hit) rel = `node_modules/${pkg}/${hit}`
    }
  }
  entryCache.set(spec, rel)
  return rel
}

const normPath = (p) => {
  const stack = []
  for (const seg of p.split('/')) {
    if (seg === '..') stack.pop()
    else if (seg && seg !== '.') stack.push(seg)
  }
  return stack.join('/')
}
// Strip comments (string-aware, so URLs like 'https://...' survive) before
// scanning for specifiers: JSDoc type references such as
// @template {import('./types/index').X} T would otherwise count as imports.
const stripComments = (src) => {
  let out = ''
  let state = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'code') {
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === '`') state = 'tpl'
      else if (c === '/' && d === '/') { state = 'line'; i++; continue }
      else if (c === '/' && d === '*') { state = 'block'; i++; continue }
      out += c
    } else if (state === 'sq') {
      if (c === '\\') { out += c + (d ?? ''); i++; continue }
      if (c === "'" || c === '\n') state = 'code'
      out += c
    } else if (state === 'dq') {
      if (c === '\\') { out += c + (d ?? ''); i++; continue }
      if (c === '"' || c === '\n') state = 'code'
      out += c
    } else if (state === 'tpl') {
      if (c === '\\') { out += c + (d ?? ''); i++; continue }
      if (c === '`') state = 'code'
      out += c
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n' }
    } else if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i++; continue }
      if (c === '\n') out += '\n'
    }
  }
  return out
}
const relCands = (base) => [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, `${base}/index.js`]

  const visited = new Set()
  const queue = [...libFiles]
  const missingPkgs = new Map() // pkg -> Set(importer)
  const missingFiles = []
  let filesScanned = 0
  let bareFollowed = 0
  let relFollowed = 0
  while (queue.length > 0) {
    const rel = queue.pop()
    if (visited.has(rel)) continue
    visited.add(rel)
    let src
    try { src = stripComments(readFile(rel)) } catch { continue } // unreadable node (unpacked/dir) — nothing to scan
    filesScanned++
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    for (const re of specRe) for (const m of src.matchAll(re)) {
      const spec = m[1]
      if (spec.startsWith('node:') || spec.startsWith('data:') || spec.startsWith('file:') || spec.startsWith('http') || spec === 'electron') continue
      if (spec.startsWith('.')) {
        const base = normPath(`${dir}/${spec}`)
        const hit = relCands(base).find(fileExists)
        if (hit) { queue.push(hit); relFollowed++ }
        else missingFiles.push(`missing relative import ${spec} from ${rel} -> none of ${relCands(base).join(' | ')} exists (check the package "files" field)`)
        continue
      }
      const pkg = pkgNameOf(spec)
      if (NODE_BUILTINS.has(pkg) || OPTIONAL_PKGS.has(pkg)) continue
      bareFollowed++
      if (!packages.has(pkg)) {
        if (!missingPkgs.has(pkg)) missingPkgs.set(pkg, new Set())
        missingPkgs.get(pkg).add(rel)
        continue
      }
      const entry = resolveBare(spec)
      if (entry) queue.push(entry)
      else missingFiles.push(`package ${pkg} is in the asar but entry for ${spec} (imported by ${rel}) cannot be resolved (check its package.json exports/main + "files" field)`)
    }
  }
  for (const [pkg, importers] of [...missingPkgs].sort()) {
    missingFiles.push(`MISSING PACKAGE ${pkg} (imported by ${[...importers].sort().slice(0, 3).join(', ')}${importers.size > 3 ? ` +${importers.size - 3}` : ''}) — the packaged app would crash with ERR_MODULE_NOT_FOUND; declare it as a production dependency of the desktop package, or fix its parent's dependencies/peerDependencies`)
  }
  log(`walk: ${filesScanned} files scanned, ${bareFollowed} bare + ${relFollowed} relative import(s) followed, ${visited.size} modules visited`)
  if (missingFiles.length > 0) fail([...problems, ...missingFiles])
  log('OK: the shell\'s full transitive import graph resolves inside app.asar (all packages + entry files present)')
