import { familyOf } from '../lib/price.mjs'
import type { EtaCost, EtaIdle, EtaLastRun, EtaWho, EtaWorking } from '../types'
import { costOfRun, startOfDay } from './predict'
import type { Estimate, Profile, ProfileRun } from './predict'
import type { LiveView } from './record'

// The one value the band and the pane draw from, built from the recorder's
// live view, the estimate and the profile. Plain data: the render hooks only
// read it, so a redraw is cheap and never writes.

const addCost = (to: EtaCost, c: EtaCost) => {
  to.usd += c.usd
  to.priced += c.priced
  to.unpriced += c.unpriced
}

/** The pane's WHO rows: the main loop, then the subagents grouped by model, busiest first. */
export function whoRows(live: LiveView): EtaWho[] {
  const main: EtaWho = { isMain: true, label: 'main', model: familyOf(live.model ?? ''), count: 1, ms: 0, tokens: 0, cost: { usd: 0, priced: 0, unpriced: 0 }, isOpen: live.isMainOpen }
  const groups = new Map<string, EtaWho>()
  for (const p of live.who) {
    if (p.agentId === null) {
      main.ms += p.ms
      main.tokens += p.tokens
      addCost(main.cost, p.cost)
      if (main.model === 'other' && p.model) main.model = familyOf(p.model)
      continue
    }
    const family = familyOf(p.model)
    const row = groups.get(family) ?? { isMain: false, label: family, model: family, count: 0, ms: 0, tokens: 0, cost: { usd: 0, priced: 0, unpriced: 0 }, isOpen: false }
    row.count += 1
    row.ms += p.ms
    row.tokens += p.tokens
    addCost(row.cost, p.cost)
    row.isOpen = row.isOpen || p.isOpen
    groups.set(family, row)
  }
  return [main, ...[...groups.values()].sort((a, b) => b.ms - a.ms)]
}

export function workingView(live: LiveView, est: Estimate, ctx: { contextTokens: number | null }): EtaWorking {
  return {
    kind: 'working',
    runId: live.runId,
    taskType: live.task?.taskType ?? 'freeform',
    project: live.task?.project ?? null,
    job: live.task?.job ?? null,
    state: est.state,
    isWaiting: live.isWaitingOnYou,
    learning: est.learning,
    elapsedMs: Math.round(live.agentMs),
    leftMs: est.leftMs === null ? null : Math.round(est.leftMs),
    leftSlowMs: est.leftSlowMs === null ? null : Math.round(est.leftSlowMs),
    totalMs: est.totalMs === null ? null : Math.round(est.totalMs),
    submit: est.submit ? { usualMs: Math.round(est.submit.usualMs), slowMs: Math.round(est.submit.slowMs) } : null,
    shape: live.shape,
    n: est.n,
    onTimePct: est.coverage === null ? null : Math.round(est.coverage * 100),
    scored: est.scored,
    now: live.now ? { name: live.now.name, detail: live.now.detail, sinceMs: Math.round(live.now.sinceMs) } : null,
    who: whoRows(live),
    split: { agentMs: Math.max(0, Math.round(live.agentMs - live.toolMs)), toolMs: Math.round(live.toolMs), waitMs: Math.round(live.waitMs) },
    speed: est.speed,
    context: { tokens: ctx.contextTokens, cache: live.cache },
    cost: { ...live.cost },
  }
}

export function lastRunOf(run: ProfileRun): EtaLastRun {
  const eta = run.eta
  const est = eta && eta.usualMs !== null && eta.slowMs !== null ? { usualMs: eta.usualMs, slowMs: eta.slowMs } : null
  return {
    taskType: run.taskType,
    agentMs: Math.round(run.agentMs),
    cost: costOfRun(run),
    est,
    verdict: est ? (run.agentMs <= est.slowMs ? 'on time' : 'late') : null,
    learning: eta?.learning ?? null,
  }
}

export function idleView(profile: Profile, now: number, job: string | null, canImport = false): EtaIdle {
  const last = profile.lastRun(null)
  const midnight = startOfDay(now)
  return {
    kind: 'idle',
    last: last ? lastRunOf(last) : null,
    today: profile.totals(r => r.startedAt >= midnight),
    job: job ? { name: job, ...profile.totals(r => r.job === job) } : null,
    learnedRuns: profile.history.length + profile.session.length,
    ...(canImport ? { canImport } : {}),
  }
}
