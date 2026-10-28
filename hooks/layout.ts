import type { EtaLook, EtaView, EtaWho, EtaWorking } from '../types'
import { clock, cost, left, range, rough, tokens } from './fmt'

// The band's segments and the pane's lines, as plain data: no engine calls,
// so they are tested whole and the layout check prints them at any width.
// The band: `~4m left · 2:10 in · $0.81 · website-work` while a run works
// (ending ` · subagents, usually longer` once it hands work to subagents in its
// first requests), `last wrap 3:40 (est 3-5m, on time) · today $38` when idle, segments
// dropped by priority on a narrow terminal. The pane: header, progress, time
// left, confidence, NOW, WHO, the time split, speed, context, cost.

const BAR_CELLS = 20

export type Part = { text: string; look: EtaLook; bold?: boolean }
export type Segment = { id: string; priority: number; full: Part[]; short: Part[] }
export type Fitted = { id: string; parts: Part[] }

export const SEP = ' · '

// Theme keys, not raw colors, so the row follows /theme.
export const LOOK: Record<EtaLook, { color?: string; dimColor?: boolean }> = {
  normal: {},
  dim: { dimColor: true },
  good: { color: 'success' },
  warn: { color: 'warning' },
  bad: { color: 'error' },
}

const p = (text: string, look: EtaLook = 'normal', bold = false): Part => (bold ? { text, look, bold } : { text, look })
const seg = (id: string, priority: number, full: Part[], short: Part[] = full): Segment => ({ id, priority, full, short })
const cut = (text: string, n: number) => ([...text].length <= n ? text : `${[...text].slice(0, n - 1).join('')}~`)

/** The band's segments for a view, steady ones first; none before the profile has loaded. */
export function bandSegments(view: EtaView): Segment[] {
  if (view.kind === 'none') return []
  if (view.kind === 'working') {
    let countdown: Segment
    if (view.isWaiting) countdown = seg('eta', 100, [p('waiting on you', 'warn', true)], [p('waiting', 'warn', true)])
    else if (view.state === 'learning') {
      const l = view.learning ?? { have: 0, need: 5 }
      countdown = seg('eta', 100, [p(`learning (${l.have} of ${l.need})`, 'dim')], [p(`learning ${l.have}/${l.need}`, 'dim')])
    } else if (view.state === 'past-slow' || view.leftMs === null) {
      const look: EtaLook = view.state === 'past-slow' ? 'bad' : view.state === 'past-usual' ? 'warn' : 'good'
      const text = view.state === 'on-track' ? 'on track' : 'over usual'
      countdown = seg('eta', 100, [p(text, look, look === 'bad')], [p(view.state === 'on-track' ? 'on track' : 'over', look, look === 'bad')])
    } else {
      const look: EtaLook = view.state === 'past-usual' ? 'warn' : 'good'
      countdown = seg('eta', 100, [p(`${left(view.leftMs)} left`, look)], [p(left(view.leftMs), look)])
    }
    return [
      countdown,
      seg('in', 80, [p(clock(view.elapsedMs)), p(' in', 'dim')], [p(clock(view.elapsedMs))]),
      seg('cost', 60, [p(cost(view.cost))]),
      seg('task', 40, [p(view.taskType)], [p(cut(view.taskType, 14))]),
      // work handed to subagents early: the estimate is matched to such runs, and the hint is the first to give way
      ...(view.shape === 'agents' ? [seg('agents', 30, [p('subagents, usually longer', 'dim')], [p('subagents', 'dim')])] : []),
    ]
  }
  const out: Segment[] = []
  const last = view.last
  if (last) {
    const head = [p('last ', 'dim'), p(`${last.taskType} `), p(clock(last.agentMs))]
    const tail: Part[] = []
    if (last.est && last.verdict) {
      tail.push(p(` (est ${range(last.est.usualMs, last.est.slowMs)}, `, 'dim'), p(last.verdict, last.verdict === 'on time' ? 'good' : 'warn'), p(')', 'dim'))
    } else if (last.learning) tail.push(p(` (learning ${last.learning.have} of ${last.learning.need})`, 'dim'))
    out.push(seg('last', 90, [...head, ...tail], [p('last ', 'dim'), p(`${cut(last.taskType, 14)} `), p(clock(last.agentMs))]))
  } else if (view.canImport) {
    out.push(seg('last', 90, [p('vault-eta: no runs yet. /eta backfill imports your Claude Code history', 'dim')], [p('no runs yet · /eta backfill', 'dim')]))
  } else out.push(seg('last', 90, [p('vault-eta: no runs logged yet', 'dim')], [p('no runs yet', 'dim')]))
  out.push(seg('today', 50, [p('today ', 'dim'), p(cost(view.today.cost, true))]))
  return out
}

export const partsWidth = (parts: readonly Part[]) => parts.reduce((n, part) => n + [...part.text].length, 0)

function widthOf(list: { parts: Part[] }[]): number {
  if (list.length === 0) return 0
  return list.reduce((n, s) => n + partsWidth(s.parts), 0) + SEP.length * (list.length - 1)
}

/**
 * Fits the segments into `columns`: every one
 * full if they fit; else the least important shortened first, then dropped,
 * so the countdown is the last to go.
 */
export function fitBand(segments: readonly Segment[], columns: number): Fitted[] {
  const chosen = segments.map(s => ({ id: s.id, priority: s.priority, parts: s.full, short: s.short }))
  const byPriority = [...chosen].sort((a, b) => a.priority - b.priority)
  for (const s of byPriority) {
    if (widthOf(chosen) <= columns) break
    s.parts = s.short
  }
  for (const s of byPriority) {
    if (widthOf(chosen) <= columns || chosen.length <= 1) break
    chosen.splice(chosen.indexOf(s), 1)
  }
  return chosen.map(({ id, parts }) => ({ id, parts }))
}

/** The band as one plain line, for tests and the layout check. */
export function bandText(fitted: readonly Fitted[]): string {
  return fitted.map(s => s.parts.map(part => part.text).join('')).join(SEP)
}

export type Line = Part[]

export const lineWidth = (line: Line) => line.reduce((n, part) => n + [...part.text].length, 0)
const thousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const STATE_LOOK = { learning: 'dim', 'on-track': 'good', 'past-usual': 'warn', 'past-slow': 'bad' } as const

/** The countdown as the band says it, with its look. */
function countdown(v: EtaWorking): Part {
  if (v.isWaiting) return p('waiting on you', 'warn', true)
  if (v.state === 'learning') return p(`learning (${v.learning?.have ?? 0} of ${v.learning?.need ?? 5})`, 'dim')
  if (v.state === 'past-slow') return p('over usual', 'bad', true)
  if (v.leftMs === null) return v.state === 'on-track' ? p('on track', 'good') : p('over usual', 'warn')
  return p(`${left(v.leftMs)} left`, STATE_LOOK[v.state])
}

function whoLine(w: EtaWho): Line {
  const name = (w.isMain ? `${'main'.padEnd(7)}${w.model}` : `${w.label.padEnd(7)}x${w.count}`).padEnd(14)
  const usd = w.cost.priced + w.cost.unpriced === 0 ? '--' : cost(w.cost)
  return [p(name), p(` ${clock(w.ms).padStart(4)}`), p(tokens(w.tokens).padStart(9), 'dim'), p(usd.padStart(9))]
}

/** The NOW line, its time right-aligned at `room`. */
function nowLine(v: EtaWorking, room: number): Line {
  if (!v.now) return [p('NOW', 'normal', true), p('  --', 'dim')]
  const time = clock(v.now.sinceMs)
  const head = `NOW  ${v.now.name}`
  let detail = v.now.detail
  const free = room - head.length - time.length - 4
  if (detail !== '' && [...detail].length > free) detail = free > 3 ? `${[...detail].slice(0, free - 1).join('')}~` : ''
  const body = detail === '' ? head : `${head}  ${detail}`
  const pad = Math.max(2, room - body.length - time.length)
  return [p('NOW', 'normal', true), p(`  ${v.now.name}`), ...(detail === '' ? [] : [p(`  ${detail}`, 'dim')]), p(' '.repeat(pad)), p(time)]
}

function workingLines(v: EtaWorking, columns: number): Line[] {
  const lines: Line[] = []
  const header: Line = [p(v.taskType, 'normal', true)]
  if (v.project) header.push(p(' · ', 'dim'), p(v.project))
  if (v.job) header.push(p(' · ', 'dim'), p(`job ${v.job}`))
  lines.push(header)

  if (v.state === 'learning' || !v.submit) {
    lines.push([p(`${clock(v.elapsedMs)} in`), p(' · no estimate yet', 'dim')])
    lines.push([countdown(v)])
    const l = v.learning ?? { have: 0, need: 5 }
    lines.push([p(`${l.have} past runs like this · ${Math.max(0, l.need - l.have)} more to go`, 'dim')])
  } else {
    const total = v.totalMs ?? v.submit.usualMs
    const share = total > 0 ? Math.min(1, v.elapsedMs / total) : 1
    const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(share * BAR_CELLS)))
    const look: EtaLook = v.isWaiting ? 'warn' : STATE_LOOK[v.state]
    lines.push([p('█'.repeat(filled), look), p('░'.repeat(BAR_CELLS - filled), 'dim'), p(`  ${clock(v.elapsedMs)} of ~${clock(total)}`)])
    lines.push([countdown(v), p(`    usual ${rough(v.submit.usualMs)} · slow ${rough(v.submit.slowMs)}`, 'dim')])
    const onTime = v.onTimePct === null ? 'not scored yet' : `${v.onTimePct}% finished on time`
    lines.push([p(`${v.n} past runs · ${onTime}`, 'dim')])
  }

  lines.push([])
  lines.push(nowLine(v, Math.min(columns, 40)))
  lines.push([])
  lines.push([p(`${'WHO'.padEnd(14)} time   tokens     cost`, 'dim')])
  for (const w of v.who) lines.push(whoLine(w))
  lines.push([])

  const wait = v.split.waitMs > 0 ? clock(v.split.waitMs) : '0'
  lines.push([p('agent ', 'dim'), p(clock(v.split.agentMs)), p(' · tools ', 'dim'), p(clock(v.split.toolMs)), p(' · waiting on you ', 'dim'), p(wait, v.isWaiting ? 'warn' : 'normal')])
  const speed: Line = [p('speed ', 'dim')]
  if (v.speed.tps === null) speed.push(p('--', 'dim'))
  else {
    speed.push(p(`${v.speed.tps} tok/s`))
    if (v.speed.usualTps !== null) speed.push(p(` (usual ${v.speed.usualTps})`, 'dim'))
    if (v.speed.etaPct !== null) speed.push(p(' · eta ', 'dim'), p(`${v.speed.etaPct >= 0 ? '+' : ''}${v.speed.etaPct}%`, v.speed.etaPct > 10 ? 'warn' : 'normal'))
  }
  lines.push(speed)
  lines.push([
    p('context ', 'dim'),
    p(v.context.tokens === null ? '--' : tokens(v.context.tokens)),
    p(' · cache ', 'dim'),
    p(v.context.cache ?? '--', v.context.cache === 'cold' ? 'warn' : 'normal'),
  ])
  lines.push([p(cost(v.cost), 'normal', true), p(' so far · at API prices', 'dim')])
  return lines
}

/** The pane's lines for a view, each to be cut at the pane's width. */
export function paneLines(view: EtaView, columns: number): Line[] {
  if (view.kind === 'working') return workingLines(view, columns)
  if (view.kind === 'none') return [[p('vault-eta', 'normal', true)], [p('loading the last 90 days...', 'dim')]]
  const lines: Line[] = [[p('vault-eta', 'normal', true), p(' · idle', 'dim')], []]
  const last = view.last
  if (last) {
    const line: Line = [p('last run  ', 'dim'), p(`${last.taskType} `), p(clock(last.agentMs))]
    if (last.est && last.verdict) {
      line.push(p(' · est ', 'dim'), p(range(last.est.usualMs, last.est.slowMs)), p(' · ', 'dim'), p(last.verdict, last.verdict === 'on time' ? 'good' : 'warn'))
    } else if (last.learning) line.push(p(` · learning (${last.learning.have} of ${last.learning.need})`, 'dim'))
    else line.push(p(' · no estimate', 'dim'))
    lines.push(line)
    if (last.cost.priced > 0) lines.push([p('          '), p(cost(last.cost)), p(' at API prices', 'dim')])
  } else lines.push([p('no runs logged yet', 'dim')], ...(view.canImport ? [[p('/eta backfill', 'normal'), p('  imports your Claude Code history', 'dim')]] : []))
  lines.push([])
  const t = view.today
  lines.push([p('today     ', 'dim'), p(`${t.runs} run${t.runs === 1 ? '' : 's'}`), p(' · ', 'dim'), p(clock(t.ms)), p(' · ', 'dim'), p(cost(t.cost, true))])
  if (view.job) {
    const j = view.job
    lines.push([p('job       ', 'dim'), p(`${j.name} `), p(`${j.runs} run${j.runs === 1 ? '' : 's'}`), p(' · ', 'dim'), p(clock(j.ms)), p(' · ', 'dim'), p(cost(j.cost, true))])
  }
  lines.push([])
  lines.push([p(`learned from ${thousands(view.learnedRuns)} past runs (90 days)`, 'dim')])
  lines.push([p('/eta report', 'normal'), p('  history and accuracy', 'dim')])
  lines.push([p('all dollars at API prices', 'dim')])
  return lines
}

/** The pane as plain lines, for tests and the layout check. */
export function paneText(view: EtaView, columns: number): string[] {
  return paneLines(view, columns).map(line => {
    const text = line.map(part => part.text).join('')
    return [...text].length > columns ? [...text].slice(0, columns).join('') : text
  })
}

