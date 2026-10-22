// Where the mod's `.vault-eta/` folder lives: one base folder per session,
// the same answer on every reload whatever folder the shell has wandered into.
// Paths are compared with forward slashes, so a Windows path (`C:\Users\me\notes`)
// walks up the same way as a POSIX one; the answer comes back with forward
// slashes, which the file system takes on Windows too.

const MARK = '.vault-eta'

/**
 * A path with forward slashes, no doubled or trailing one; a drive root keeps
 * its slash (`C:/`), a network path its leading two (`//server/share`).
 * @param {string} path
 * @returns {string}
 */
export function slashPath(path) {
  let s = String(path).replace(/\\/g, '/')
  const isUnc = s.startsWith('//')
  s = s.replace(/\/{2,}/g, '/')
  if (isUnc) s = `/${s}`
  if (/^[A-Za-z]:$/.test(s)) return `${s}/`
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

/**
 * True at the top of a file system: `/`, a drive root (`C:/`), or a network share (`//server/share`).
 * @param {string} path a slashPath
 * @returns {boolean}
 */
function isRoot(path) {
  return path === '/' || /^[A-Za-z]:\/$/.test(path) || /^\/\/[^/]+\/[^/]+$/.test(path)
}

/**
 * The same folder, ignoring case for a Windows path (its file system does).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSame(a, b) {
  return /^[A-Za-z]:/.test(a) || a.startsWith('//') ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The path with any `.vault-eta` segment (and what follows it) cut off.
 * @param {string} path
 * @returns {string}
 */
export function cutMark(path) {
  const s = slashPath(path)
  const parts = s.split('/')
  const at = parts.indexOf(MARK)
  if (at < 0) return s
  const kept = parts.slice(0, at).join('/')
  return kept === '' ? '/' : slashPath(kept)
}

/**
 * The parent folder, or null at the top of a file system.
 * @param {string} path
 * @returns {string | null}
 */
export function parentOf(path) {
  const s = slashPath(path)
  if (isRoot(s)) return null
  const i = s.lastIndexOf('/')
  if (i < 0) return null
  return i === 0 ? '/' : slashPath(s.slice(0, i))
}

/**
 * The base folder for a start path. Cuts a `.vault-eta` segment off, then walks
 * up to the nearest folder that already has `.vault-eta/`, else the nearest
 * with `.git`, else the start itself. The walk stops at the top of the file
 * system and at home (home itself is only the answer when it is the start).
 * `namesIn(dir)` lists a folder's entry names, or null when it cannot be read.
 *
 * @param {string} start
 * @param {{ namesIn: (dir: string) => Promise<string[] | null>, home?: string }} io
 * @returns {Promise<string>}
 */
export async function resolveBase(start, io) {
  const origin = cutMark(start)
  const home = io.home ? slashPath(io.home) : ''
  /** @type {string[]} */
  const chain = []
  /** @type {string | null} */
  let dir = origin
  for (; dir !== null; dir = parentOf(dir)) {
    if (dir !== origin && ((home !== '' && isSame(dir, home)) || isRoot(dir))) break
    chain.push(dir)
  }
  /** @type {Array<string[] | null>} */
  const listings = []
  for (const dir of chain) listings.push(await io.namesIn(dir))
  const eta = chain.findIndex((_, i) => listings[i]?.includes(MARK))
  if (eta >= 0) return chain[eta] ?? origin
  const git = chain.findIndex((_, i) => listings[i]?.includes('.git'))
  if (git >= 0) return chain[git] ?? origin
  return origin
}
