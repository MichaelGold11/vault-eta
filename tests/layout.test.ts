import { describe, expect, test } from 'claude-code/testing'

import { clock, cost, left, money, moneyRound, range, rough, tokens } from '../hooks/fmt'
import { bandSegments, bandText, fitBand, paneText } from '../hooks/layout'
import type { EtaIdle, EtaWorking } from '../types'

// The band's segments and the pane's lines as plain data, at any width.

const working = (over: Partial<EtaWorking> = {}): EtaWorking => ({
  kind: 'working',
  runId: 'p1',
  taskType: 'website-work',
  project: 'website',
  job: 'onboarding',
  state: 'on-track',
  isWaiting: false,
  learning: null,
  elapsedMs: 130_000,
  leftMs: 230_000,
  leftSlowMs: 400_000,
  totalMs: 360_000,
  submit: { usualMs: 360_000, slowMs: 540_000 },
  n: 34,
  onTimePct: 82,
  scored: 11,
  now: { name: 'Bash', detail: 'bun run build', sinceMs: 41_000 },
  who: [
    { isMain: true, label: 'main', model: 'opus', count: 1, ms: 80_000, tokens: 48_200, cost: { usd: 0.61, priced: 1, unpriced: 0 }, isOpen: true },
    { isMain: false, label: 'sonnet', model: 'sonnet', count: 1, ms: 52_000, tokens: 21_000, cost: { usd: 0.18, priced: 1, unpriced: 0 }, isOpen: false },
    { isMain: false, label: 'haiku', model: 'haiku', count: 2, ms: 9000, tokens: 4100, cost: { usd: 0.02, priced: 2, unpriced: 0 }, isOpen: false },
  ],
  split: { agentMs: 91_000, toolMs: 39_000, waitMs: 0 },
  speed: { tps: 62, usualTps: 70, etaPct: 8 },
  context: { tokens: 96_000, cache: 'warm' },
  cost: { usd: 0.81, priced: 4, unpriced: 0 },
  ...over,
})

const idle: EtaIdle = {
  kind: 'idle',
  last: { taskType: 'wrap', agentMs: 220_000, cost: { usd: 0.42, priced: 1, unpriced: 0 }, est: { usualMs: 180_000, slowMs: 300_000 }, verdict: 'on time', learning: null },
  today: { runs: 12, ms: 2_470_000, cost: { usd: 38.2, priced: 12, unpriced: 0 } },
  job: { name: 'onboarding', runs: 7, ms: 3_720_000, cost: { usd: 12.1, priced: 7, unpriced: 0 } },
  learnedRuns: 1031,
}

const band = (view: Parameters<typeof bandSegments>[0], columns = 200) => bandText(fitBand(bandSegments(view), columns))

describe('formats', () => {
  test('clock, rough, left, range, money, tokens', () => {
    expect([clock(130_000), clock(41_000), clock(3_725_000), clock(-5)]).toEqual(['2:10', '0:41', '1:02:05', '0:00'])
    expect([rough(40_000), rough(240_000), rough(4_800_000), rough(3_600_000)]).toEqual(['40s', '4m', '1h 20m', '1h'])
    expect([left(36_000), left(4000), left(230_000), left(-1)]).toEqual(['~40s', '~10s', '~4m', '~10s'])
    expect([range(180_000, 300_000), range(40_000, 50_000), range(40_000, 120_000), range(105_000, 132_000)]).toEqual(['3-5m', '40-50s', '40s-2m', '2m'])
    expect([money(0.81), money(0.004), money(0), money(123.4), moneyRound(38.2), moneyRound(4.5)]).toEqual(['$0.81', '<$0.01', '$0.00', '$123', '$38', '$4.50'])
    expect([tokens(912), tokens(48_200), tokens(1_340_000)]).toEqual(['912', '48.2k', '1.3M'])
  })

  test('a cost with no price shows --, one with only part priced ends in +', () => {
    expect(cost({ usd: 0.81, priced: 3, unpriced: 0 })).toBe('$0.81')
    expect(cost({ usd: 0, priced: 0, unpriced: 2 })).toBe('--')
    expect(cost({ usd: 0.81, priced: 3, unpriced: 1 })).toBe('$0.81+')
    expect(cost({ usd: 38.2, priced: 9, unpriced: 1 }, true)).toBe('$38+')
    expect(cost({ usd: 0, priced: 0, unpriced: 0 })).toBe('$0.00')
  })
})

describe('the band row', () => {
  test('working, on track: the countdown, elapsed, cost and task', () => {
    expect(band(working())).toBe('~4m left · 2:10 in · $0.81 · website-work')
    expect(bandSegments(working())[0]?.full[0]).toEqual({ text: '~4m left', look: 'good' })
  })

  test('past usual is warning, past slow is error and says over usual, never a negative countdown', () => {
    const late = bandSegments(working({ state: 'past-usual', leftMs: 60_000 }))[0]?.full[0]
    expect(late).toEqual({ text: '~1m left', look: 'warn' })
    expect(band(working({ state: 'past-usual', leftMs: null }))).toBe('over usual · 2:10 in · $0.81 · website-work')
    const over = bandSegments(working({ state: 'past-slow', elapsedMs: 600_000, leftMs: null }))[0]?.full[0]
    expect(over).toEqual({ text: 'over usual', look: 'bad', bold: true })
    expect(band(working({ state: 'past-slow', elapsedMs: 600_000, leftMs: 5000 }))).toBe('over usual · 10:00 in · $0.81 · website-work')
  })

  test('waiting on you replaces the countdown; learning is dim', () => {
    expect(band(working({ isWaiting: true }))).toBe('waiting on you · 2:10 in · $0.81 · website-work')
    expect(bandSegments(working({ isWaiting: true }))[0]?.full[0]?.look).toBe('warn')
    const learning = working({ state: 'learning', learning: { have: 3, need: 5 }, leftMs: null, submit: null })
    expect(band(learning)).toBe('learning (3 of 5) · 2:10 in · $0.81 · website-work')
    expect(bandSegments(learning)[0]?.full[0]?.look).toBe('dim')
  })

  test('a model missing from the price table: -- with no price, + with part of it', () => {
    expect(band(working({ cost: { usd: 0, priced: 0, unpriced: 3 } }))).toBe('~4m left · 2:10 in · -- · website-work')
    expect(band(working({ cost: { usd: 0.81, priced: 3, unpriced: 1 } }))).toBe('~4m left · 2:10 in · $0.81+ · website-work')
    expect(band({ ...idle, today: { runs: 12, ms: 2_470_000, cost: { usd: 38.2, priced: 11, unpriced: 1 } } })).toBe('last wrap 3:40 (est 3-5m, on time) · today $38+')
    const lines = paneText(working({ cost: { usd: 0, priced: 0, unpriced: 2 }, who: [{ isMain: true, label: 'main', model: 'other', count: 1, ms: 1000, tokens: 10, cost: { usd: 0, priced: 0, unpriced: 2 }, isOpen: true }] }), 45)
    expect(lines.at(-1)).toBe('-- so far · at API prices')
    expect(lines.find(l => l.startsWith('main'))?.trimEnd().endsWith('--')).toBe(true)
  })

  test('idle: the last run against its estimate, and today', () => {
    expect(band(idle)).toBe('last wrap 3:40 (est 3-5m, on time) · today $38')
    expect(band({ ...idle, last: { ...idle.last!, agentMs: 400_000, verdict: 'late' } })).toBe('last wrap 6:40 (est 3-5m, late) · today $38')
    expect(band({ ...idle, last: null, today: { runs: 0, ms: 0, cost: { usd: 0, priced: 0, unpriced: 0 } } })).toBe('vault-eta: no runs logged yet · today $0.00')
    expect(band({ kind: 'none' })).toBe('')
  })
})

describe('narrow widths', () => {
  test('least important first: shortened, then dropped (task, cost, elapsed); the countdown stays', () => {
    const v = working({ taskType: 'website-work-long-name' })
    expect(band(v, 80)).toBe('~4m left · 2:10 in · $0.81 · website-work-long-name')
    expect(band(v, 40)).toBe('~4m left · 2:10 · $0.81 · website-work-~')
    expect(band(v, 30)).toBe('~4m · 2:10 · $0.81')
    expect(band(v, 15)).toBe('~4m · 2:10')
    expect(band(v, 5)).toBe('~4m')
    expect(band(idle, 40)).toBe('last wrap 3:40 · today $38')
    expect(band(idle, 20)).toBe('last wrap 3:40')
  })
})

describe('the pane lines', () => {
  test('working: header, progress, time left, NOW, WHO, the split, speed, context, cost', () => {
    expect(paneText(working(), 45)).toEqual([
      'website-work · website · job onboarding',
      '███████░░░░░░░░░░░░░  2:10 of ~6:00',
      '~4m left    usual 6m · slow 9m',
      '34 past runs · 82% finished on time',
      '',
      'NOW  Bash  bun run build            0:41',
      '',
      'WHO            time   tokens     cost',
      'main   opus    1:20    48.2k    $0.61',
      'sonnet x1      0:52    21.0k    $0.18',
      'haiku  x2      0:09     4.1k    $0.02',
      '',
      'agent 1:31 · tools 0:39 · waiting on you 0',
      'speed 62 tok/s (usual 70) · eta +8%',
      'context 96.0k · cache warm',
      '$0.81 so far · at API prices',
    ])
  })

  test('learning and waiting', () => {
    const lines = paneText(working({ state: 'learning', learning: { have: 3, need: 5 }, submit: null, leftMs: null, totalMs: null, isWaiting: true }), 45)
    expect(lines.slice(0, 4)).toEqual(['website-work · website · job onboarding', '2:10 in · no estimate yet', 'waiting on you', '3 past runs like this · 2 more to go'])
  })

  test('idle: the last run, today, the job, the report', () => {
    expect(paneText(idle, 45)).toEqual([
      'vault-eta · idle',
      '',
      'last run  wrap 3:40 · est 3-5m · on time',
      '          $0.42 at API prices',
      '',
      'today     12 runs · 41:10 · $38',
      'job       onboarding 7 runs · 1:02:00 · $12',
      '',
      'learned from 1,031 past runs (90 days)',
      '/eta report  history and accuracy',
      'all dollars at API prices',
    ])
  })

  test('lines are cut at the pane width', () => {
    for (const line of paneText(working(), 30)) expect([...line].length).toBeLessThan(31)
  })
})
