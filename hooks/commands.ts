import type { EngineInterface } from 'claude-code'

import { fmtCost, fmtDur } from '../lib/format.mjs'
import { buildReport } from '../lib/report.mjs'
import { refusalOf } from './guard'
import { joinPath, loadAll } from './log'
import type { Profile } from './predict'

// What /eta report and /eta job do. Like the rest of /eta they print no
// reply: nothing reaches the model, and the answer is a toast. register.tsx
// routes the command here and rebuilds the view after a job changes.

type Engine = EngineInterface

/** The `$.store` key `/eta job <name>` sets; read at each run's start. */
export const JOB_KEY = 'job'
const JOB_MAX = 40
const TOAST_MS = 6000

/** A job name as stored: lowercase, a-z 0-9 and hyphens, at most 40 characters; empty when nothing usable is left. */
export function sanitizeJob(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, JOB_MAX)
    .replace(/-+$/, '')
}

/** The job in a stored value; null when none is set. */
export function jobName(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string') {
    const name = (value as { name: string }).name.trim()
    return name === '' ? null : name
  }
  return null
}

/** A job's totals from the profile, as the toasts read them. */
function jobTotals(profile: Profile, name: string): string {
  const t = profile.totals(r => r.job === name)
  return `${t.runs} run${t.runs === 1 ? '' : 's'}, ${fmtDur(t.ms)}, ${fmtCost(t.cost.usd, t.cost.priced, t.cost.unpriced)} at API prices`
}

/**
 * `/eta job`, `/eta job <name>` and `/eta job end`. Returns whether the job
 * changed, so the caller rebuilds the view (the pane header shows the job at once).
 */
export async function jobCommand($: Engine, profile: Profile, rest: string): Promise<boolean> {
  const current = jobName(await $.store.get(JOB_KEY).catch(() => undefined))
  const arg = rest.trim()
  if (arg === '') {
    $.ui.toast(current ? `job ${current}: ${jobTotals(profile, current)}` : 'no job set. /eta job <name> tags the runs after it.', { timeoutMs: TOAST_MS })
    return false
  }
  if (arg.toLowerCase() === 'end') {
    if (!current) {
      $.ui.toast('no job set.', { timeoutMs: TOAST_MS })
      return false
    }
    const totals = jobTotals(profile, current)
    await $.store.delete(JOB_KEY)
    $.ui.toast(`job ${current} ended: ${totals}`, { timeoutMs: TOAST_MS })
    return true
  }
  const name = sanitizeJob(arg)
  if (name === '') {
    $.ui.toast('a job name needs letters or numbers: /eta job my-build', { timeoutMs: TOAST_MS })
    return false
  }
  await $.store.set(JOB_KEY, name)
  $.ui.toast(`job ${name}: runs are tagged until /eta job end`, { timeoutMs: TOAST_MS })
  return true
}

/**
 * Where the report may be written: a relative `.md` path that stays inside
 * the folder the logs live under (no `..`, no drive or root, nothing under a
 * `.git` or `.vault-eta` folder). Null when the setting asks for anything else,
 * so a setting can never point the report at another file on the machine.
 */
export function safeReportPath(cwd: string, reportPath: string): string | null {
  const text = reportPath.trim()
  if (/^([a-zA-Z]:)?[\\/]/.test(text) || text.startsWith('~')) return null
  const parts = text.split(/[\\/]+/).filter(p => p !== '' && p !== '.')
  if (parts.length === 0 || !/\.md$/i.test(parts[parts.length - 1] ?? '')) return null
  if (parts.some(p => p === '..' || p.toLowerCase() === '.git' || p.toLowerCase() === '.vault-eta' || /[:\0]/.test(p))) return null
  return joinPath(cwd, ...parts)
}

/** True for a note this mod wrote: its frontmatter carries the report's tags and `generated: true`. */
export function isReportFile(text: string): boolean {
  if (!text.startsWith('---\n')) return false
  const end = text.indexOf('\n---', 3)
  if (end < 0) return false
  const head = text.slice(4, end).split('\n').map(line => line.trim())
  return head.includes('tags: [vault-eta, report]') && head.includes('generated: true')
}

/**
 * Why the report may not be written at `path` (inside `base` by its
 * spelling), or null when it may. The shared write rule first (no symbolic
 * link at the file, nothing that resolves outside the base; a linked folder
 * inside the vault is fine while it stays inside); then a file already there
 * must be a report this mod wrote, so a note of the person's is never
 * overwritten.
 */
export async function reportRefusal($: Engine, base: string, path: string): Promise<string | null> {
  const refusal = await refusalOf($, base, path, { linkedFolders: true })
  if (refusal !== null) return refusal
  const own = await $.fs.stat(path).catch(() => undefined)
  if (own) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const text = await $.fs.read(path).catch(() => null)
    if (text === null || !isReportFile(text)) return `${name} exists and was not written by vault-eta (move it, or set reportPath)`
  }
  return null
}

/** Writes the report of every run ever logged (and this session's unflushed rows) to `reportPath`, then toasts where, or why not. */
export async function reportCommand($: Engine, cwd: string, profile: Profile, reportPath: string) {
  try {
    const path = safeReportPath(cwd, reportPath)
    if (path === null) throw new Error('the reportPath option must be a relative .md path inside the folder (no .. or drive)')
    const refusal = await reportRefusal($, cwd, path)
    if (refusal !== null) {
      $.ui.toast(`/eta report not written: ${refusal}`, { timeoutMs: TOAST_MS })
      return
    }
    const rows = [...(await loadAll($, cwd)), ...profile.sessionRows]
    const text = buildReport(rows, { now: await $.clock.now() })
    await $.fs.write(path, text)
    $.ui.toast(`report written: ${path}`, { timeoutMs: TOAST_MS })
  } catch (error) {
    $.ui.toast(`/eta report failed: ${error instanceof Error ? error.message : String(error)}`, { timeoutMs: TOAST_MS })
  }
}
