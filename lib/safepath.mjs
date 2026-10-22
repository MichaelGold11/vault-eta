// @ts-check
// Where the mod may write: one rule for the report, the log files and the
// backfill. A write lands on `path`, which lies under `base` by its spelling;
// it must not be steered elsewhere by a symbolic link an untrusted folder
// planted (`.vault-eta` linked to another folder, a log file linked to a
// dotfile, a link that leads nowhere yet). Free of file access: the caller
// hands in `io` ($.fs in the mod, node:fs in the scripts).

/**
 * @typedef {{ isLink: boolean, kind: 'file' | 'dir' | 'other' }} PathKind
 * @typedef {{ lstat: (path: string) => Promise<PathKind | null>, realPath: (path: string) => Promise<string | null> }} PathIo
 */

/**
 * Forward slashes, no trailing one.
 * @param {string} p
 * @returns {string}
 */
const slashes = p => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')

/**
 * `path` is `root` or lies under it, compared without case (macOS and Windows
 * file systems ignore it).
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
export function isInside(path, root) {
  const a = slashes(path).toLowerCase()
  const b = slashes(root).toLowerCase()
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)
}

/**
 * Why writing `path` must not happen, or null when it may. Refused: the
 * target is a symbolic link (one leading nowhere included) or not a file; a
 * folder between `base` and the target is a link, unless `linkedFolders`
 * allows it; the deepest part of the path that exists resolves, links
 * followed, outside the resolved `base`. Parts that do not exist yet are
 * made by the write itself, as plain folders.
 * @param {PathIo} io
 * @param {string} base
 * @param {string} path
 * @param {{ linkedFolders?: boolean }} [options] `linkedFolders`: a linked folder that still resolves inside `base` is allowed (the report, in a vault that links folders in)
 * @returns {Promise<string | null>}
 */
export async function writeRefusal(io, base, path, options = {}) {
  const b = slashes(base)
  const p = slashes(path)
  if (!isInside(p, b) || p.length <= b.length) return 'the path is not inside the folder'
  const root = await io.realPath(b)
  if (root === null) return 'the folder could not be resolved'
  const segments = p.slice(b.length).split('/').filter(s => s !== '')
  let at = b
  let deepest = b
  for (let i = 0; i < segments.length; i++) {
    at = `${at}/${segments[i]}`
    const kind = await io.lstat(at)
    if (kind === null) break
    const name = segments.slice(0, i + 1).join('/')
    const isTarget = i === segments.length - 1
    if (kind.isLink && (isTarget || !options.linkedFolders)) return `${name} is a symbolic link`
    if (isTarget && kind.kind !== 'file') return `${name} is not a file`
    // an allowed linked folder is judged by where it resolves, below
    if (!isTarget && !kind.isLink && kind.kind !== 'dir') return `${name} is not a folder`
    deepest = at
  }
  if (deepest !== b) {
    const real = await io.realPath(deepest)
    if (real === null || !isInside(real, root)) return `${slashes(deepest).slice(b.length + 1)} leads outside the folder`
  }
  return null
}
