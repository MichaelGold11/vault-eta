// vault-eta's $.state contract: the one value the band and the pane draw
// from, rebuilt by the mod's one-second timer and its events (a render hook
// never writes), and whether the person closed the pane this session.

/** How a part is drawn: a theme color key (layout.ts LOOK maps each to the theme). */
export type EtaLook = 'normal' | 'dim' | 'good' | 'warn' | 'bad'

/**
 * Dollars at API prices: the sum of the parts that had a price, and how many
 * parts had one and how many had none (a model missing from the price
 * table). Drawn `--` when nothing had a price and `$X+` when only part did.
 */
export type EtaCost = { usd: number; priced: number; unpriced: number }

/** Where a working run stands against its estimate. */
export type EtaState = 'learning' | 'on-track' | 'past-usual' | 'past-slow'

/** One row of the pane's WHO table: the main loop, or the subagents on one model. */
export type EtaWho = {
  isMain: boolean
  /** `main`, or the model family of the subagents (`sonnet`). */
  label: string
  /** The model family: opus, sonnet, haiku, fable. */
  model: string
  /** How many loops the row adds up (subagents: x2). */
  count: number
  /** Their own working time: waits on the person, sleep and time spent in Agent calls left out. */
  ms: number
  /** New tokens: input, cache writes and output (cache reads left out). */
  tokens: number
  cost: EtaCost
  isOpen: boolean
}

/** What the main loop is doing right now. */
export type EtaNow = {
  /** A tool's name (`Bash`), or the model's family while a request streams. */
  name: string
  /** The command's first words, a folder, an agent type, a skill, or `writing`. */
  detail: string
  sinceMs: number
}

export type EtaEstimateRange = { usualMs: number; slowMs: number }

export type EtaWorking = {
  kind: 'working'
  runId: string
  taskType: string
  project: string | null
  job: string | null
  state: EtaState
  isWaiting: boolean
  learning: { have: number; need: number } | null
  /** Run time so far, the clock the log keeps: the time the main loop or any of its subagents worked, less waits on the person and machine sleep. */
  elapsedMs: number
  /** The expected remaining run time, usual and slow; null once past every past run. */
  leftMs: number | null
  leftSlowMs: number | null
  /** The expected whole run (elapsed plus left), else the usual figure. */
  totalMs: number | null
  /** The estimate at submit, as stored on the run's rows. */
  submit: EtaEstimateRange | null
  /** What the run did in its first requests, once known; `agents` (work handed to subagents) adds the band's hint. */
  shape: string | null
  /** Past runs matched, and how often runs of this kind finished under the slow figure. */
  n: number
  onTimePct: number | null
  scored: number
  now: EtaNow | null
  who: EtaWho[]
  /** Main loop time outside tools, tool time (Agent calls left out), waits on the person. */
  split: { agentMs: number; toolMs: number; waitMs: number }
  speed: { tps: number | null; usualTps: number | null; etaPct: number | null }
  context: { tokens: number | null; cache: 'warm' | 'cold' | null }
  cost: EtaCost
}

export type EtaLastRun = {
  taskType: string
  agentMs: number
  cost: EtaCost
  /** Its estimate at submit; null when it had none (learning, or backfilled). */
  est: EtaEstimateRange | null
  verdict: 'on time' | 'late' | null
  learning: { have: number; need: number } | null
}

export type EtaTotals = { runs: number; ms: number; cost: EtaCost }

export type EtaIdle = {
  kind: 'idle'
  last: EtaLastRun | null
  today: EtaTotals
  job: (EtaTotals & { name: string }) | null
  /** Past runs the profile learned from (90 days, backfill included). */
  learnedRuns: number
  /** True while the log has no runs and Claude Code kept transcripts for this folder: the band says how to import them. */
  canImport?: boolean
}

export type EtaView = { kind: 'none' } | EtaWorking | EtaIdle

declare module 'claude-code' {
  interface PluginState {
    'vault-eta': {
      view: EtaView
      /** The person closed the pane (its mark, a key, or /eta): it stops opening by itself. */
      isPaneDismissed: boolean
    }
  }
}
