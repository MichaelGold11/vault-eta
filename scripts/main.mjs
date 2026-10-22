// The scripts' "run directly" check, shared so all three agree. A file URL
// is turned into a path with fileURLToPath (a space stays a space, a Windows
// drive stays a drive), and both sides are resolved through symbolic links.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} p
 * @returns {string}
 */
function realOf(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * True when the module at `url` (its `import.meta.url`) is the script node or
 * bun was asked to run, false when a test imports it.
 * @param {string} url
 * @returns {boolean}
 */
export function isMainModule(url) {
  const entry = process.argv[1]
  if (!entry) return false
  return realOf(path.resolve(entry)) === realOf(fileURLToPath(url))
}
