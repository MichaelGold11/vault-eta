#!/usr/bin/env node
// Write the vault-eta report from the log, all time.
//
//   node scripts/report.mjs --vault ~/notes [--out <path>]
//
// --vault the vault (default: the current folder); reads every
//         .vault-eta/runs/<machine>/*.jsonl under it
// --out   where the note goes (default <vault>/vault-eta-report.md)
//
// The note is built by lib/report.mjs, the same builder /eta report uses.

import fs from 'node:fs'
import path from 'node:path'
import { buildReport } from '../lib/report.mjs'
import { isMainModule } from './main.mjs'

export function parseArgs(argv) {
  /** @type {any} */
  const o = { vault: process.cwd(), out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--vault') o.vault = path.resolve(argv[++i] ?? '')
    else if (a === '--out') o.out = path.resolve(argv[++i] ?? '')
  }
  if (!o.out) o.out = path.join(o.vault, 'vault-eta-report.md')
  return o
}

/** Every turn row under <vault>/.vault-eta/runs, whatever its age; a line that does not parse is skipped. */
export function loadAllRows(vault) {
  const root = path.join(vault, '.vault-eta', 'runs')
  const rows = []
  if (!fs.existsSync(root)) return rows
  for (const machine of fs.readdirSync(root, { withFileTypes: true })) {
    if (!machine.isDirectory()) continue
    for (const name of fs.readdirSync(path.join(root, machine.name)).sort()) {
      if (!name.endsWith('.jsonl')) continue
      for (const line of fs.readFileSync(path.join(root, machine.name, name), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          if (r && r.kind === 'turn') rows.push(r)
        } catch {}
      }
    }
  }
  return rows
}

if (isMainModule(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2))
  const rows = loadAllRows(opts.vault)
  fs.mkdirSync(path.dirname(opts.out), { recursive: true })
  fs.writeFileSync(opts.out, buildReport(rows, { now: Date.now() }))
  console.log(`${rows.length} rows -> ${opts.out}`)
}
