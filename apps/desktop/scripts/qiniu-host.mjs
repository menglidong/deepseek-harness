/** Normalize a Qiniu CDN host secret to a bare host, tolerating an accidental scheme prefix and trailing slash. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu

/**
 * @param {string | undefined} raw Secret value, e.g. "updates.example.com", "https://updates.example.com", "https://updates.example.com/".
 * @returns {string | undefined} Bare host, or undefined when the value is not a host (e.g. it contains a path).
 */
export function normalizeQiniuCdnHost(raw) {
  let value = String(raw ?? '').trim()
  while (SCHEME.test(value)) value = value.replace(SCHEME, '').trim()
  value = value.replace(/\/+$/u, '').trim()
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/iu.test(value) ? value : undefined
}
