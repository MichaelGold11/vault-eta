// @ts-check
// Cold start: what `/eta backfill` needs to run the backfill (scripts/backfill-core.mjs)
// from inside the mod. A hooks module has no node:fs, so the transcripts, the
// live log and the writes all go through a small file interface ($.fs in the
// mod, a memory one in the tests). The rules are the script's: a symbolic link
// is never read or written, nothing lands outside the vault, and only the
// machine's own `backfill-YYYY-MM[.partN].jsonl` files are replaced. $.fs has
// no delete, so a file the new run no longer needs is emptied instead.

import { backfill, transcriptsSlug, validMachine, writeOut } from '../scripts/backfill-core.mjs'

/**
 * What of $.fs this needs.
 * @typedef {{ name: string, kind: string, isLink?: boolean }} Entry
 * @typedef {{
 *   list: (path: string) => Promise<Entry[]>,
 *   read: (path: string) => Promise<string>,
 *   write: (path: string, text: string) => Promise<void>,
 *   stat: (path: string, options?: { resolve?: boolean }) => Promise<{ kind: string, isLink?: boolean, realPath?: string }>,
 * }} Fs
 */

const SKIPPED = 'transcripts over 4 MiB are not read here'

/** Forward slashes, folders joined without doubling. */
export function join(/** @type {string[]} */ ...parts) {
  return parts
    .filter(p => p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/')
}

/**
 * Claude Code's projects folder: under CLAUDE_CONFIG_DIR when set, else `~/.claude`.
 * @param {{ CLAUDE_CONFIG_DIR?: string, HOME?: string, USERPROFILE?: string }} env
 * @returns {string | null}
 */
export function projectsRoot(env) {
  const config = env.CLAUDE_CONFIG_DIR?.trim()
  if (config) return join(config, 'projects')
  const home = env.HOME ?? env.USERPROFILE
  return home ? join(home, '.claude', 'projects') : null
}

/** The names of the plain `.jsonl` files in a folder (a link is never one), sorted; empty when it cannot be listed. */
async function jsonlIn(/** @type {Fs} */ fs, /** @type {string} */ dir) {
  try {
    return (await fs.list(dir)).filter(e => e.kind === 'file' && !e.isLink && e.name.endsWith('.jsonl')).map(e => e.name).sort()
  } catch {
    return []
  }
}

/**
 * The folder holding this vault's transcripts: the slug of the vault path, or
 * of its real path (a link or an alias), whichever has transcripts. Null when
 * neither does.
 * @param {Fs} fs
 * @param {string} vault
 * @param {string | null} root the projects folder
 * @returns {Promise<{ dir: string, files: string[] } | null>}
 */
export async function findTranscripts(fs, vault, root) {
  if (root === null) return null
  const names = [vault]
  const real = (await fs.stat(vault, { resolve: true }).catch(() => undefined))?.realPath
  if (real && real !== vault) names.push(real)
  for (const name of names) {
    const dir = join(root, transcriptsSlug(name))
    const files = await jsonlIn(fs, dir)
    if (files.length > 0) return { dir, files }
  }
  return null
}

/**
 * The transcripts and the live log as the backfill reads them. It lists
 * everything first (the core asks for file lists and meta files without
 * waiting), then hands the lines of a file out on demand. A file $.fs cannot
 * read (over 4 MiB) gives no lines and is counted in `tooBig`.
 * @param {Fs} fs
 * @param {{ dir: string, files: string[] }} found
 * @param {string} runsDir the vault's `.vault-eta/runs`
 */
export async function transcriptIo(fs, found, runsDir) {
  /** @type {Map<string, string[]>} */
  const subs = new Map()
  /** @type {Map<string, any>} */
  const metas = new Map()
  for (const file of found.files) {
    const sessionId = file.slice(0, -'.jsonl'.length)
    const dir = join(found.dir, sessionId, 'subagents')
    const list = await jsonlIn(fs, dir)
    if (list.length === 0) continue
    subs.set(sessionId, list)
    for (const sf of list) {
      const key = `${sessionId}/subagents/${sf.replace(/\.jsonl$/, '.meta.json')}`
      try {
        metas.set(key, JSON.parse(await fs.read(join(found.dir, key))))
      } catch {
        // no meta file, or one that is not JSON: the core copes with none
      }
    }
  }
  /** The run ids the live recorder already logged: the backfill leaves those. */
  const liveIds = new Set()
  try {
    for (const m of await fs.list(runsDir)) {
      if (m.kind !== 'dir' || m.isLink) continue
      for (const f of await jsonlIn(fs, join(runsDir, m.name))) {
        if (f.startsWith('backfill-')) continue
        try {
          for (const line of (await fs.read(join(runsDir, m.name, f))).split('\n')) {
            if (!line) continue
            try {
              const r = JSON.parse(line)
              if (r.kind !== 'session' && r.runId) liveIds.add(r.runId)
            } catch {
              // a torn line
            }
          }
        } catch {
          // an unreadable log file: its runs may be imported again, and are dropped later as duplicates
        }
      }
    }
  } catch {
    // no live log yet
  }
  const state = { tooBig: 0 }
  const io = {
    mainFiles: () => found.files,
    subFiles: (/** @type {string} */ sessionId) => subs.get(sessionId) ?? [],
    lines: async function* (/** @type {string} */ file) {
      let text
      try {
        text = await fs.read(join(found.dir, file))
      } catch {
        state.tooBig += 1
        return
      }
      for (const line of text.split('\n')) yield line
    },
    meta: (/** @type {string} */ file) => metas.get(file) ?? null,
    liveRunIds: () => liveIds,
  }
  return { io, state }
}

/**
 * The disk writeOut works on, over $.fs. Links are not followed for the write
 * rule (lstat), the folders are made by the write, and a file to be removed
 * is emptied because $.fs cannot delete.
 * @param {Fs} fs
 */
export function fsDisk(fs) {
  return {
    lstat: async (/** @type {string} */ path) => {
      const st = await fs.stat(path).catch(() => undefined)
      if (st) return { isLink: !!st.isLink, kind: /** @type {'file' | 'dir' | 'other'} */ (st.kind === 'file' ? 'file' : st.kind === 'dir' ? 'dir' : 'other') }
      // a link that leads nowhere may not stat: its folder's listing still names it
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      if (cut <= 0) return null
      try {
        const entry = (await fs.list(path.slice(0, cut))).find(e => e.name === path.slice(cut + 1))
        return entry?.isLink ? { isLink: true, kind: /** @type {const} */ ('other') } : null
      } catch {
        return null
      }
    },
    realPath: async (/** @type {string} */ path) => (await fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath ?? null,
    join,
    mkdir: () => {},
    list: async (/** @type {string} */ dir) => (await fs.list(dir)).map(e => e.name),
    remove: (/** @type {string} */ file) => fs.write(file, ''),
    write: (/** @type {string} */ file, /** @type {string} */ text) => fs.write(file, text),
  }
}

/**
 * Is there history to import? True when the log has no runs (the caller
 * checks) and this vault has transcripts.
 * @param {Fs} fs
 * @param {string} vault
 * @param {string | null} root
 */
export async function canImport(fs, vault, root) {
  return (await findTranscripts(fs, vault, root)) !== null
}

/**
 * Runs the backfill for the vault and writes it. Returns one short line for
 * a toast. Throws when the write rule refuses (the message says why).
 * @param {Fs} fs
 * @param {{ vault: string, machine: string, root: string | null, ignore?: string[], projectsFolder?: string }} opts
 * @returns {Promise<string>}
 */
export async function importHistory(fs, opts) {
  if (!validMachine(opts.machine)) throw new Error('this machine has no id yet')
  const found = await findTranscripts(fs, opts.vault, opts.root)
  if (found === null) return 'no Claude Code transcripts found for this folder'
  const { io, state } = await transcriptIo(fs, found, join(opts.vault, '.vault-eta', 'runs'))
  const args = { vault: opts.vault, machine: opts.machine, ignore: opts.ignore ?? [], projectsFolder: opts.projectsFolder ?? '', dryRun: false }
  const res = await backfill(args, io)
  await writeOut(args, res, fsDisk(fs))
  const runs = new Set(res.kept.filter((/** @type {any} */ r) => !r.agentId).map((/** @type {any} */ r) => r.runId)).size
  const big = state.tooBig > 0 ? `; ${state.tooBig} transcript${state.tooBig === 1 ? '' : 's'} skipped (${SKIPPED}; node scripts/backfill.mjs reads them)` : ''
  return `imported ${runs} run${runs === 1 ? '' : 's'}${big}`
}
