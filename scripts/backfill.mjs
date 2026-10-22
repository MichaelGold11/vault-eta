#!/usr/bin/env node
// Backfill the vault-eta log from Claude Code's transcripts.
//
//   node scripts/backfill.mjs --vault ~/notes --machine laptop [--projects-dir <dir>] [--ignore "kickoff"] [--projects-folder Projects] [--dry-run]
//
// --vault           the vault (default: the current folder)
// --machine         required: a name for this computer, letters, digits, dash or underscore.
//                   It becomes the folder under .vault-eta/runs/. The live mod picks
//                   a random id of its own that a script cannot read, so any name works;
//                   backfilled runs the live log already has are skipped by run id.
// --projects-dir    the transcripts (default ~/.claude/projects/<the vault path with every
//                   character that is not a letter or digit turned into a dash>)
// --ignore          skills that do not name a task (default none)
// --projects-folder the vault-relative folder that holds projects (default: detected)
// --dry-run         print the totals, write nothing
//
// Output: <vault>/.vault-eta/runs/<machine>/backfill-YYYY-MM.jsonl, whole files,
// replaced on every run, and <vault>/.vault-eta/.gitignore (just `*`) when it
// is missing. Runs the live recorder already logged are skipped. Nothing is
// written or deleted when a symbolic link sits on the way (.vault-eta, runs,
// the machine folder, a file) or a path resolves outside the vault.
// The logic is in backfill-core.mjs; this file is the file access.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { parseList } from '../lib/classify.mjs'
import { backfill, isWindowsPath, summarize, transcriptsSlug, validMachine, writeOut } from './backfill-core.mjs'
import { isMainModule } from './main.mjs'

/** A vault path as given: made absolute here, except a Windows path, which is kept as typed (path.resolve would mangle it off Windows). */
export function resolveVault(/** @type {string} */ v) {
  return isWindowsPath(v) ? v : path.resolve(v)
}

export function parseArgs(argv) {
  /** @type {any} */
  const o = { vault: process.cwd(), projectsDir: null, machine: null, dryRun: false, ignore: [], projectsFolder: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--vault') o.vault = resolveVault(argv[++i] ?? '')
    else if (a === '--projects-dir') o.projectsDir = path.resolve(argv[++i] ?? '')
    else if (a === '--machine') o.machine = String(argv[++i] ?? '')
    else if (a === '--ignore') o.ignore = parseList(argv[++i])
    else if (a === '--projects-folder') o.projectsFolder = String(argv[++i] ?? '')
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--debug') o.debug = true
  }
  if (!o.projectsDir) o.projectsDir = findTranscripts(o.vault)
  return o
}

/**
 * The transcripts folder for a vault: the slug of the vault path, or of its
 * real path (a symlink or a /tmp alias), whichever exists; the first slug
 * when neither does.
 */
export function findTranscripts(/** @type {string} */ vault) {
  const base = path.join(os.homedir(), '.claude', 'projects')
  const names = [vault]
  try { if (!isWindowsPath(vault)) names.push(fs.realpathSync(vault)) } catch {}
  const dirs = names.map(n => path.join(base, transcriptsSlug(n)))
  return dirs.find(d => fs.existsSync(d)) ?? dirs[0]
}

/** The transcripts and the live log, from disk. */
export function diskIo(opts) {
  const root = opts.projectsDir
  const runsDir = path.join(opts.vault, '.vault-eta', 'runs')
  return {
    mainFiles: () => (fs.existsSync(root) ? fs.readdirSync(root).filter(f => f.endsWith('.jsonl')).sort() : []),
    subFiles: sessionId => {
      const dir = path.join(root, sessionId, 'subagents')
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort() : []
    },
    lines: file => readline.createInterface({ input: fs.createReadStream(path.join(root, file), { encoding: 'utf8' }), crlfDelay: Infinity }),
    meta: file => {
      try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) } catch { return null }
    },
    liveRunIds: () => {
      const ids = new Set()
      if (!fs.existsSync(runsDir)) return ids
      for (const m of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!m.isDirectory()) continue
        for (const f of fs.readdirSync(path.join(runsDir, m.name))) {
          if (!f.endsWith('.jsonl') || f.startsWith('backfill-')) continue
          for (const line of fs.readFileSync(path.join(runsDir, m.name, f), 'utf8').split('\n')) {
            if (!line) continue
            try { const r = JSON.parse(line); if (r.kind !== 'session' && r.runId) ids.add(r.runId) } catch {}
          }
        }
      }
      return ids
    },
  }
}

/** The disk as writeOut (backfill-core.mjs) uses it: links not followed for the write rule, then the writes themselves. */
export const nodeDisk = {
  lstat: async (/** @type {string} */ p) => {
    try {
      const st = fs.lstatSync(p)
      return { isLink: st.isSymbolicLink(), kind: /** @type {'file' | 'dir' | 'other'} */ (st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other') }
    } catch {
      return null
    }
  },
  realPath: async (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return null
    }
  },
  join: (/** @type {string[]} */ ...parts) => path.join(...parts),
  mkdir: (/** @type {string} */ dir) => void fs.mkdirSync(dir, { recursive: true }),
  list: (/** @type {string} */ dir) => fs.readdirSync(dir),
  remove: (/** @type {string} */ file) => fs.rmSync(file),
  write: (/** @type {string} */ file, /** @type {string} */ text) => fs.writeFileSync(file, text),
}

if (isMainModule(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2))
  if (!validMachine(opts.machine)) {
    console.error('--machine <name> is required: a name for this computer, letters, digits, dash or underscore (for example --machine laptop).')
    process.exit(2)
  }
  if (!fs.existsSync(opts.projectsDir)) {
    console.error(`No transcripts folder at ${opts.projectsDir}. Pass --projects-dir with the right folder under ~/.claude/projects/.`)
    process.exit(2)
  }
  const res = await backfill(opts, diskIo(opts))
  if (!opts.dryRun) {
    try {
      await writeOut(opts, res, nodeDisk)
    } catch (error) {
      console.error(`backfill: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
  }
  console.log(summarize(res, opts))
}
