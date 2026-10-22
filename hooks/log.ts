import type { EngineInterface } from 'claude-code'

import { refusalOf } from './guard'
import type { LogRow, RunTask, SessionRow, TurnRow } from './record'

// The session's log file: `.vault-eta/runs/<machineId>/<YYYY-MM-DD>-<sessionId>.jsonl`
// under the session's folder. $.fs has no append, so rows stay in memory and
// the current part is rewritten at each run's end; one writer per file, so
// Mac and Windows never touch the same one. Past ROLL_BYTES (512 KiB) the
// part is sealed and the next rows go to `...part2.jsonl`, which keeps each
// rewrite small (a synced folder uploads less, an exit writes less). A flush
// with nothing new since the last one writes nothing.

type Engine = EngineInterface

export const LOG_ROOT = '.vault-eta/runs'
/** The `.vault-eta` folder's own ignore file: ignore everything in it, itself included. */
export const GITIGNORE_TEXT = '*\n'

export const ROLL_BYTES = 512 * 1024
export const HISTORY_DAYS = 90

const encoder = new TextEncoder()
const bytesOf = (s: string) => encoder.encode(s).length

export function joinPath(...parts: string[]): string {
  return parts
    .filter(p => p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/')
}

/** A log write the shared write rule refused (a symbolic link on its way, or a path that resolves outside the base). */
export class WriteRefused extends Error {}

/**
 * Makes the log folder ignore itself in git: writes `.vault-eta/.gitignore`
 * containing `*` whenever that file is missing (a new folder, or one deleted
 * and made again by a later write), so nobody commits their logs by accident.
 * An ignore file that exists is left as its owner has it: emptying it is how
 * the logs are committed on purpose. Returns why the folder may not be
 * written at all (a symbolic link at `.vault-eta` or the ignore file, or a
 * path that resolves outside the base), else null.
 */
export async function ensureGitignore($: Engine, base: string): Promise<string | null> {
  const file = joinPath(base, '.vault-eta', '.gitignore')
  const refusal = await refusalOf($, base, file)
  if (refusal !== null) return refusal
  try {
    if (await $.fs.exists(file)) return null
    await $.fs.write(file, GITIGNORE_TEXT)
  } catch {
    // no ignore file is not worth failing a session over
  }
  return null
}

/** The local calendar date of a time, `YYYY-MM-DD`. */
export function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A session id as it appears in a file name: letters, digits, dash and underscore only, so an id can never carry a path. */
export function safeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '-')
}

export function fileName(date: string, sessionId: string, part: number): string {
  const id = safeId(sessionId)
  return part <= 1 ? `${date}-${id}.jsonl` : `${date}-${id}.part${part}.jsonl`
}

export function parseFileName(name: string): { date: string; sessionId: string; part: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})-(.+?)(?:\.part(\d+))?\.jsonl$/.exec(name)
  if (!m || !m[1] || !m[2]) return null
  return { date: m[1], sessionId: m[2], part: m[3] ? Number(m[3]) : 1 }
}

/**
 * A backfill file's month and part, as scripts/backfill.mjs names them:
 * `backfill-2026-10.jsonl`, `backfill-2026-10.part2.jsonl`.
 */
export function parseBackfillName(name: string): { month: string; part: number } | null {
  const m = /^backfill-(\d{4}-\d{2})(?:\.part(\d+))?\.jsonl$/.exec(name)
  if (!m || !m[1]) return null
  return { month: m[1], part: m[2] ? Number(m[2]) : 1 }
}

export function toJsonl(rows: readonly LogRow[]): string {
  return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
}

/** Rows of a JSONL file; a line that does not parse (a write cut short) is skipped. */
export function parseJsonl(text: string): LogRow[] {
  const rows: LogRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as LogRow
      if (row && typeof row === 'object' && (row.kind === 'turn' || row.kind === 'session')) rows.push(row)
    } catch {
      // skipped
    }
  }
  return rows
}

export type SessionTotals = { turns: number; usd: number; unpriced: number; start: number | null }

export class SessionLog {
  readonly dir: string
  readonly date: string
  readonly sessionId: string
  part = 1
  rows: TurnRow[] = []
  bytes = 0
  /** Every part's turns, for the session row. */
  readonly totals: SessionTotals = { turns: 0, usd: 0, unpriced: 0, start: null }
  /** The engine's total cost and this log's logged cost when this instance took the log on. */
  private engineBase: number | null = null
  private loggedBase = 0
  /** Parts sealed by a rollover and not yet written. */
  private sealed: Array<{ path: string; text: string }> = []
  /** Rows added in all, and how many of them the last good flush had: unequal means a flush has work. */
  private added = 0
  private flushed = 0

  constructor(dir: string, date: string, sessionId: string) {
    this.dir = dir
    this.date = date
    this.sessionId = sessionId
  }

  /** Call once the log is read back from disk: later ratios compare only what happened after this point. */
  markBaseline(engineUsd: number | null) {
    this.engineBase = engineUsd
    this.loggedBase = this.totals.usd
  }

  path(part = this.part): string {
    return joinPath(this.dir, fileName(this.date, this.sessionId, part))
  }

  private count(row: TurnRow) {
    this.totals.turns += 1
    if (typeof row.usd === 'number') this.totals.usd += row.usd
    else this.totals.unpriced += 1
    this.totals.start = this.totals.start === null ? row.start : Math.min(this.totals.start, row.start)
  }

  /** Keeps a row; seals the current part first when the row would carry it past ROLL_BYTES. */
  add(row: TurnRow, taskFor?: (runId: string) => RunTask | undefined) {
    const size = bytesOf(JSON.stringify(row)) + 1
    if (this.rows.length > 0 && this.bytes + size > ROLL_BYTES) {
      this.sealed.push({ path: this.path(), text: toJsonl(this.refreshed(taskFor)) })
      this.part += 1
      this.rows = []
      this.bytes = 0
    }
    this.rows.push(row)
    this.bytes += size
    this.count(row)
    this.added += 1
  }

  /** Rows (or a sealed part) not on disk yet. */
  isDirty(): boolean {
    return this.added !== this.flushed || this.sealed.length > 0
  }

  /** How many rows a flush starting now covers; `markFlushed` with it once the flush succeeded. */
  mark(): number {
    return this.added
  }

  markFlushed(mark: number) {
    this.flushed = mark
  }

  /** The rows with each run's task as it stands now (a skill loaded late in a run names the earlier rows too). */
  private refreshed(taskFor?: (runId: string) => RunTask | undefined): TurnRow[] {
    if (!taskFor) return this.rows
    return this.rows.map(r => {
      const task = taskFor(r.runId)
      return task ? { ...r, task } : r
    })
  }

  sessionRow(input: { machineId: string; now: number; engineUsd: number | null; version: string | null }): SessionRow {
    const logged = Math.round(this.totals.usd * 1e6) / 1e6
    const base = this.engineBase
    const hasBase = base !== null && input.engineUsd !== null
    const engineDelta = hasBase && input.engineUsd !== null ? input.engineUsd - base : input.engineUsd
    const loggedDelta = hasBase ? this.totals.usd - this.loggedBase : this.totals.usd
    return {
      v: 1,
      kind: 'session',
      src: 'live',
      machineId: input.machineId,
      sessionId: this.sessionId,
      start: this.totals.start ?? input.now,
      end: input.now,
      turns: this.totals.turns,
      loggedUsd: logged,
      unpricedTurns: this.totals.unpriced,
      engineUsd: input.engineUsd,
      ...(hasBase ? { engineBaseUsd: Math.round(base * 1e6) / 1e6, loggedBaseUsd: Math.round(this.loggedBase * 1e6) / 1e6 } : {}),
      ratio: engineDelta !== null && engineDelta > 0 ? Math.round((loggedDelta / engineDelta) * 1000) / 1000 : null,
      version: input.version,
    }
  }

  /** What a flush writes: any sealed part, then the current part whole, the session row last. */
  writes(
    taskFor: ((runId: string) => RunTask | undefined) | undefined,
    session: { machineId: string; now: number; engineUsd: number | null; version: string | null },
  ): Array<{ path: string; text: string; isSealed: boolean }> {
    const out = this.sealed.map(p => ({ ...p, isSealed: true }))
    if (this.rows.length > 0 || this.totals.turns > 0) {
      out.push({ path: this.path(), text: toJsonl([...this.refreshed(taskFor), this.sessionRow(session)]), isSealed: false })
    }
    return out
  }

  /** A sealed part reached the disk. */
  wrote(path: string) {
    this.sealed = this.sealed.filter(p => p.path !== path)
  }

  /** Takes in a part of this session's log read back from disk; the newest part's rows are kept to be rewritten. */
  takeIn(part: number, rows: readonly LogRow[], isNewest: boolean) {
    const turns = rows.filter((r): r is TurnRow => r.kind === 'turn')
    for (const t of turns) this.count(t)
    if (isNewest) {
      this.part = part
      this.rows = turns
      this.bytes = turns.reduce((s, r) => s + bytesOf(JSON.stringify(r)) + 1, 0)
    }
  }
}

/**
 * Writes a log's sealed parts and its current part. `guard` says why a path
 * may not be written (refusalOf); a refusal throws WriteRefused before
 * anything goes through it.
 */
export async function flushLog(
  $: Engine,
  log: SessionLog,
  taskFor: ((runId: string) => RunTask | undefined) | undefined,
  session: { machineId: string; now: number; engineUsd: number | null; version: string | null },
  guard?: (path: string) => Promise<string | null>,
) {
  const mark = log.mark()
  for (const w of log.writes(taskFor, session)) {
    const refusal = guard ? await guard(w.path) : null
    if (refusal !== null) throw new WriteRefused(refusal)
    await $.fs.write(w.path, w.text)
    if (w.isSealed) log.wrote(w.path)
  }
  log.markFlushed(mark)
}

/**
 * Picks up a log this session already has on disk (a hot reload, or a
 * resume on the same machine and day): its newest part's rows are kept to be
 * rewritten, every part's turns are counted.
 */
export async function reloadLog($: Engine, log: SessionLog) {
  let names: string[]
  try {
    names = (await $.fs.list(log.dir)).filter(e => e.kind === 'file').map(e => e.name)
  } catch {
    return
  }
  const parts = names
    .map(name => ({ name, parsed: parseFileName(name) }))
    .filter(p => p.parsed !== null && p.parsed.sessionId === safeId(log.sessionId) && p.parsed.date === log.date)
    .sort((a, b) => (a.parsed?.part ?? 0) - (b.parsed?.part ?? 0))
  const newest = parts[parts.length - 1]
  for (const p of parts) {
    try {
      log.takeIn(p.parsed?.part ?? 1, parseJsonl(await $.fs.read(joinPath(log.dir, p.name))), p === newest)
    } catch {
      // an unreadable part is left out
    }
  }
}

/**
 * Every machine's turn rows from the last `days` days under the folder: the
 * history the profile is built from. Session files go by the date in their
 * name; backfill files (one a month) by their month, then each row by its
 * start. A backfilled run the live recorder also logged is dropped later,
 * when rows become runs (dedupeRuns: a live row wins).
 */
export async function loadRecent($: Engine, cwd: string, now: number, days = HISTORY_DAYS): Promise<TurnRow[]> {
  const root = joinPath(cwd, LOG_ROOT)
  const isAll = !Number.isFinite(days)
  const cutoffMs = isAll ? -Infinity : now - days * 86_400_000
  const cutoff = isAll ? '' : localDate(cutoffMs)
  const rows: TurnRow[] = []
  let machines: string[]
  try {
    machines = (await $.fs.list(root)).filter(e => e.kind === 'dir').map(e => e.name)
  } catch {
    return rows
  }
  for (const machine of machines) {
    let files: string[]
    try {
      files = (await $.fs.list(joinPath(root, machine))).filter(e => e.kind === 'file').map(e => e.name)
    } catch {
      continue
    }
    for (const name of files) {
      const parsed = parseFileName(name)
      const backfill = parsed ? null : parseBackfillName(name)
      if (parsed ? parsed.date < cutoff : !backfill || backfill.month < cutoff.slice(0, 7)) continue
      try {
        for (const r of parseJsonl(await $.fs.read(joinPath(root, machine, name)))) {
          if (r.kind !== 'turn') continue
          if (backfill && !(typeof r.start === 'number' && r.start >= cutoffMs)) continue
          rows.push(r)
        }
      } catch {
        // an unreadable file is left out
      }
    }
  }
  return rows
}

/** Every row ever logged under the folder, whatever its age (the report reads this). */
export function loadAll($: Engine, cwd: string): Promise<TurnRow[]> {
  return loadRecent($, cwd, 0, Infinity)
}
