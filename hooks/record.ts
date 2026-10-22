import {
  EDIT_TOOLS,
  classifyRun,
  commandHead,
  folderOf,
  isNoticeText,
  isPersonPrompt,
  SHAPE_STEPS,
  shapeOf,
  linesChanged,
  taskIdOf,
  toolPath,
} from '../lib/classify.mjs'
import { costOf, familyOf, tokensOf } from '../lib/price.mjs'
import { clip, lengthOf, overlapMs, subtract } from '../lib/spans.mjs'
import type { Span } from '../lib/spans.mjs'

// The recorder: what happened in each run, kept in memory while it runs and
// turned into one log row per turn.complete (the main loop's and every
// subagent's). A run is one person's prompt; its subagents, background ones
// that finish later included, and the notification turns that hand their
// results back all belong to it. State lives in a mutable module object
// rather than $.state; the band and pane draw from a derived view.
//
// Never kept: prompt text, file contents, tool output, full Bash commands.

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Effort = string | number

/** One model request: time to its first token and its writing speed separate model speed from the rest. */
export type StepRow = {
  /** Milliseconds from the turn's start. */
  at: number
  /** Left out when it is the row's own model (or effort): the row says it once. */
  model?: string
  effort?: Effort
  ms: number
  /** From the request leaving this hook to the first streamed token (text, thinking or a tool call). */
  firstTokenMs: number | null
  /** Output tokens over the time from the first token to the stop chunk. */
  tokensPerSec: number | null
  tokens: Tokens | null
  usd: number | null
  /** Characters of thinking streamed (0 when the model's thinking display is omitted). */
  thinkingChars?: number
  stop: string | null
}

export type ToolRow = {
  at: number
  name: string
  /** Wall time of the call: a permission prompt, if one was shown, and the tool. */
  ms: number
  /** The tool's own time, as the engine reports it (PostToolUse duration_ms). */
  runMs?: number
  /** Time held waiting on the person (or the auto-mode decider). */
  waitMs?: number
  /** tool.check answered ask. */
  asked?: true
  error?: true
  /** Still running when its turn ended (an interrupt). */
  cut?: true
  /** Bash: the first words only. */
  cmd?: string
  /** File tools: the folder, never the file's content. */
  dir?: string
  /** Edit and Write: lines added, lines removed. */
  lines?: [number, number]
  skill?: string
  agentType?: string
  /** TodoWrite: items done, items in the list. */
  tasks?: [number, number]
  background?: true
}

export type RunTask = {
  taskType: string
  skill: string | null
  command: string | null
  project: string | null
  /** The `/eta job` tag in force when the run began. */
  job: string | null
  /** Length of the prompt in characters; never its text. */
  promptChars: number
  /** The prompt's origin kind: composer, sdk, bridge, scheduled-trigger, ... */
  origin: string
  runStart: number
}

export type Compaction = { trigger: string; before?: number; after?: number }

export type Conditions = {
  /** Context tokens when the run began ($.session.usage()). */
  contextStart: number | null
  /** Input tokens of this loop's first request in the turn. */
  contextTurn: number | null
  /** The first request read most of its prompt from the cache (warm) or wrote it (cold). */
  cache: 'warm' | 'cold' | null
  hour: number
  weekday: number
  tzOffsetMin: number
  permissionMode: string | null
  version: string | null
  cwdName: string
  compactions?: Compaction[]
}

export type Outcome = 'finished' | 'aborted' | 'error' | 'refusal'

/**
 * The estimate made as the run began (refreshed while its first two model
 * requests settle which task it is), kept on its main rows so the report
 * can score it against what the run took.
 */
export type StoredEta = {
  taskType: string
  project: string | null
  model: string | null
  /** The match level used (`type+project+model`, ...), null while learning. */
  level: string | null
  /** Past runs matched. */
  n: number
  learning: { have: number; need: number } | null
  usualMs: number | null
  slowMs: number | null
  usualUsd: number | null
  slowUsd: number | null
  /** The self-score's correction applied to the slow figure. */
  factor: number
  /** Main model requests done when it was made. */
  steps: number
}

/** A step-time estimate of the whole run, made `atMs` of agent time in: the one nearest half the run is kept. */
export type MidEta = { atMs: number; usualMs: number; slowMs: number }

/** Dollars at API prices: the priced parts' sum, and how many parts had a price and how many had none (a model missing from the price table). */
export type Cost = { usd: number; priced: number; unpriced: number }

/** One loop's share of a run: who worked, on what model, for how long and at what cost. */
export type WhoPart = {
  key: string
  agentId: string | null
  type: string | null
  model: string
  /** Its own working time: waits on the person, sleep and time in Agent calls left out. */
  ms: number
  /** New tokens: input, cache writes and output. */
  tokens: number
  cost: Cost
}

/** The running run as the band and the pane draw it (liveView). */
export type LiveView = {
  runId: string
  task: RunTask | undefined
  isWorking: boolean
  isMainOpen: boolean
  startedAt: number
  /** Wall time less machine sleep. */
  elapsedMs: number
  /** Time held by the person (a question, a plan, a permission dialog), sleep left out. */
  waitMs: number
  /** elapsedMs less waitMs: what the estimate compares with past runs. */
  agentMs: number
  /** The main loop's tool time, Agent calls and waits left out. */
  toolMs: number
  /** The run's cost so far, from each model request as it ends. */
  cost: Cost
  mainSteps: number
  /** What the run did in its first requests (answer, read, shell, edit, agents); null until its third request begins. */
  shape: string | null
  model: string | null
  effort: Effort | null
  promptChars: number
  tasks: { done: number; total: number }
  isWaitingOnYou: boolean
  now: { kind: 'tool' | 'model'; name: string; detail: string; sinceMs: number } | null
  agents: Array<{ agentId: string; type: string; model: string; isOpen: boolean; background: boolean }>
  who: Array<WhoPart & { isOpen: boolean }>
  /** Writing speed of this run's main requests, newest last. */
  recentTps: number[]
  /** Whether the main loop's latest request read its prompt from the cache. */
  cache: 'warm' | 'cold' | null
}

export type TurnRow = {
  v: 1
  kind: 'turn'
  src: 'live'
  machineId: string
  sessionId: string
  runId: string
  turnId: string
  /** The subagent's id; null on the main loop. */
  agentId: string | null
  parentAgentId: string | null
  agentType: string | null
  background: boolean | null
  model: string
  effort: Effort | null
  start: number
  end: number
  /** The engine's durationMs: the turn's wall time. */
  ms: number
  /** ms less waiting on the person and machine sleep: what the ETA learns. */
  agentMs: number
  modelMs: number
  toolMs: number
  waitMs: number
  sleepMs: number
  outcome: Outcome
  tokens: Tokens
  /** At API prices; null when the model is not in the price table. */
  usd: number | null
  unpriced?: true
  steps: StepRow[]
  tools: ToolRow[]
  /** Machine sleep inside the turn, as [at, ms]. */
  sleeps?: Array<[number, number]>
  errors: { tools: number; steps: number }
  task: RunTask
  cond: Conditions
  /** Main rows only: the run's estimate at submit. */
  eta?: StoredEta
  /** Main rows only: the step-time estimate made nearest half the run. */
  etaMid?: MidEta
}

export type SessionRow = {
  v: 1
  kind: 'session'
  src: 'live'
  machineId: string
  sessionId: string
  start: number
  end: number
  turns: number
  /** Sum of the logged turns' usd, all parts of the session's log. */
  loggedUsd: number
  unpricedTurns: number
  /** The engine's own session total, as /cost has it. */
  engineUsd: number | null
  /** The engine's total when this recorder took the log on: cost it never saw (the session ran before the mod, or before a reload). */
  engineBaseUsd?: number | null
  /** The log's loggedUsd at that moment (rows read back from disk). */
  loggedBaseUsd?: number
  /** Cost logged since the baseline over the engine's cost since it (like with like; near 1 means the log priced what the engine counted). Without a baseline, loggedUsd over engineUsd. */
  ratio: number | null
  version: string | null
}

export type LogRow = TurnRow | SessionRow

export type RecorderConfig = {
  cacheWriteTtl: '1h' | '5m'
  ignoreSkills: string[]
  /** The vault-relative folder that holds projects; empty detects it. */
  projectsFolder?: string
  tickMs: number
  sleepGapMs: number
}

type StopReason = string | null
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model?: string
}

/** A model request in flight, timed by the turn.step stream. */
export type LiveStep = {
  loop: string
  agentId: string | null
  index: number
  startedAt: number
  endedAt: number | null
  firstAt: number | null
  stopAt: number | null
  model: string
  effort?: Effort
  usage: Usage | null
  thinking: number
  stop: StopReason
}

type LiveTool = {
  id: string
  loop: string
  name: string
  startedAt: number
  endedAt: number | null
  failed: boolean
  asked: boolean
  runMs?: number
  /** classic.PermissionRequest raised for it: a dialog put it to the person. */
  dialog: boolean
  /** When it was seen running (its progress row drew): the person had answered by then. */
  runningAt: number | null
  info: Omit<ToolRow, 'at' | 'name' | 'ms'>
}

type Loop = {
  key: string
  agentId: string | null
  turnId: string
  startedAt: number
  steps: LiveStep[]
  tools: LiveTool[]
  compactions: Compaction[]
}

export type Run = {
  id: string
  seq: number
  startedAt: number
  endedAt: number | null
  isMainOpen: boolean
  origin: string
  promptChars: number
  command: string | null
  skills: string[]
  /** Per skill, the main-loop tool calls made before it that were not skill loads. */
  skillWork: number[]
  workCalls: number
  editedDirs: string[]
  readDirs: string[]
  job: string | null
  contextStart: number | null
  permissionMode: string | null
  /** From each request's usage as it ends: the live total a band shows, and how many requests had a price and how many had none. */
  liveUsd: number
  pricedSteps: number
  unpricedSteps: number
  mainSteps: number
  /** Main model requests begun, and the names of the tools called in the first few (for the shape). */
  stepsBegun: number
  earlyTools: string[]
  tasks: { done: number; total: number }
  notifications: number
  /** The main loop's model and effort, from its first request. */
  model: string | null
  effort: Effort | null
  /** Waits on the person in the run's finished turns, clock time. */
  waitSpans: Span[]
  /** The run's finished turns, one part each. */
  done: WhoPart[]
  /** Tool time of the main loop's finished turns, Agent calls and waits left out. */
  closedToolMs: number
  eta: StoredEta | null
  checkpoints: MidEta[]
}

type Agent = {
  agentId: string
  runId: string | null
  parentAgentId: string | null
  type: string
  model: string
  background: boolean
  permissionMode: string | null
  isOpen: boolean
}

type Pending = {
  origin: string
  isNotice: boolean
  chars: number
  command: string | null
  taskId: string | null
  promptId: string | null
}

export type SessionInfo = {
  machineId: string
  sessionId: string
  cwd: string
  cwdName: string
  version: string | null
  startedAt: number
}

/** The tools whose whole time is the person's: a question, a plan to approve. */
export const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
/** The tools that hand work to a subagent: their time is the subagent's, not the caller's. */
export const AGENT_TOOLS = new Set(['Agent', 'Task'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const MAX_WAIT_SPANS = 500
const MAX_CHECKPOINTS = 200
const MAX_DONE = 500
const MAX_DIRS = 200
const MAX_STEPS = 1000
const MAX_TOOLS = 2000
const MAX_SLEEPS = 500
/** Finished runs kept in memory (for late background results and the band); older ones are dropped. */
export const KEEP_RUNS = 50

const round = (n: number) => Math.round(n)
/** Dollars to the nano-dollar, so a row reads $0.00722027 rather than float noise. */
const roundUsd = (n: number | null) => (n === null ? null : Math.round(n * 1e9) / 1e9)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function nameOfFolder(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function outcomeOf(reason: string): Outcome {
  if (reason === 'aborted') return 'aborted'
  if (reason === 'error') return 'error'
  if (reason === 'refusal') return 'refusal'
  return 'finished'
}

function pushCapped(list: string[], value: string) {
  if (list.length < MAX_DIRS) list.push(value)
}

export class Recorder {
  readonly cfg: RecorderConfig
  session: SessionInfo | null = null
  readonly runs = new Map<string, Run>()
  currentRunId: string | null = null
  readonly agents = new Map<string, Agent>()
  /** Background task ids (an agent's, a backgrounded command's) to the run that started them. */
  readonly tasks = new Map<string, string>()
  readonly loops = new Map<string, Loop>()
  readonly liveTools = new Map<string, LiveTool>()
  readonly checks = new Map<string, string>()
  sleeps: Span[] = []
  lastTick: number | null = null
  pending: Pending | null = null
  /** Compactions while no main turn was open (a /compact while idle): they join the next main turn. */
  pendingCompactions: Compaction[] = []
  permissionMode: string | null = null
  private seq = 0

  constructor(cfg: RecorderConfig) {
    this.cfg = cfg
  }

  startSession(info: { machineId: string; sessionId: string; cwd: string; version: string | null; now: number }) {
    this.session = {
      machineId: info.machineId,
      sessionId: info.sessionId,
      cwd: info.cwd,
      cwdName: nameOfFolder(info.cwd),
      version: info.version,
      startedAt: info.now,
    }
  }

  setSessionId(sessionId: string) {
    if (this.session) this.session.sessionId = sessionId
  }

  currentRun(): Run | undefined {
    return this.currentRunId === null ? undefined : this.runs.get(this.currentRunId)
  }

  // ---------------------------------------------------------------- prompts and runs

  /**
   * A prompt entered. One submitted while idle starts a turn of its own: a
   * person's opens a run there, a background task's notification rejoins the
   * run that owns the task. One delivered into a running turn is part of it.
   */
  promptSubmitted(input: { origin: string; isMidTurn: boolean; text: string; command?: string | null }) {
    if (input.isMidTurn) return
    const isNotice = input.origin === 'task-notification' || (!isPersonPrompt({ kind: input.origin }) && isNoticeText(input.text))
    this.pending = {
      origin: input.origin,
      isNotice,
      chars: input.text.length,
      command: input.command ?? null,
      taskId: isNotice ? taskIdOf(input.text) : null,
      promptId: null,
    }
  }

  /** The classic UserPromptSubmit hook's fields: the prompt's stable id (the transcript's promptId) and the mode. */
  classicPrompt(input: { promptId?: string; permissionMode?: string }) {
    if (input.permissionMode) this.permissionMode = input.permissionMode
    if (input.promptId && this.pending && !this.pending.isNotice) this.pending.promptId = input.promptId
  }

  noteMode(mode: unknown) {
    if (typeof mode === 'string' && mode !== '') this.permissionMode = mode
  }

  private openRun(p: Pending | null, now: number): Run {
    this.seq += 1
    const sessionId = this.session?.sessionId ?? 'session'
    let id = p?.promptId ?? `${sessionId}:${now}`
    if (this.runs.has(id)) id = `${id}:${this.seq}`
    const run: Run = {
      id,
      seq: this.seq,
      startedAt: now,
      endedAt: null,
      isMainOpen: true,
      origin: p?.origin ?? 'unknown',
      promptChars: p?.chars ?? 0,
      command: p?.command ?? null,
      skills: [],
      skillWork: [],
      workCalls: 0,
      editedDirs: [],
      readDirs: [],
      job: null,
      contextStart: null,
      permissionMode: this.permissionMode,
      liveUsd: 0,
      pricedSteps: 0,
      unpricedSteps: 0,
      mainSteps: 0,
      stepsBegun: 0,
      earlyTools: [],
      tasks: { done: 0, total: 0 },
      notifications: 0,
      model: null,
      effort: null,
      waitSpans: [],
      done: [],
      closedToolMs: 0,
      eta: null,
      checkpoints: [],
    }
    this.runs.set(id, run)
    this.currentRunId = id
    return run
  }

  /** The run a background task's notification belongs to. */
  private ownerOf(taskId: string | null): Run | undefined {
    if (taskId !== null) {
      const byTask = this.tasks.get(taskId)
      if (byTask !== undefined) return this.runs.get(byTask)
      if (this.agents.has(taskId)) {
        const runId = this.runOf(taskId)
        if (runId !== null) return this.runs.get(runId)
      }
    }
    // Unknown task: the newest run with a background agent still working, else with any, else the current one.
    const newestFirst = [...this.runs.values()].reverse()
    for (const isOpenOnly of [true, false]) {
      for (const run of newestFirst) {
        for (const a of this.agents.values()) if (a.background && a.runId === run.id && (a.isOpen || !isOpenOnly)) return run
      }
    }
    return this.currentRun() ?? newestFirst[0]
  }

  /** The main loop's turn began. Returns the run when this turn opened a new one. */
  mainTurnStarted(input: { turnId: string; text: string; now: number }): Run | null {
    const p = this.pending
    this.pending = null
    const isNotice = p ? p.isNotice : isNoticeText(input.text)
    let opened: Run | null = null
    if (isNotice) {
      const owner = this.ownerOf(p?.taskId ?? taskIdOf(input.text))
      if (owner) {
        this.currentRunId = owner.id
        owner.isMainOpen = true
        owner.notifications += 1
      } else opened = this.openRun(p, input.now)
    } else if (p !== null || this.currentRun() === undefined) {
      opened = this.openRun(p, input.now)
    } else {
      const run = this.currentRun()
      if (run) run.isMainOpen = true
    }
    this.loops.set('main', { key: 'main', agentId: null, turnId: input.turnId, startedAt: input.now, steps: [], tools: [], compactions: this.pendingCompactions.splice(0) })
    return opened
  }

  setRunContext(runId: string, ctx: { contextStart?: number | null; job?: string | null }) {
    const run = this.runs.get(runId)
    if (!run) return
    if (ctx.contextStart !== undefined) run.contextStart = ctx.contextStart
    if (ctx.job !== undefined) run.job = ctx.job
  }

  // ---------------------------------------------------------------- agents

  /** The run an agent belongs to: its own, else its parent's, walking up to the root. */
  runOf(agentId: string | null | undefined, depth = 0): string | null {
    if (agentId === null || agentId === undefined || agentId === '') return this.currentRunId
    const a = this.agents.get(agentId)
    if (!a) return this.currentRunId
    if (a.runId !== null) return a.runId
    if (a.parentAgentId !== null && depth < 32) return this.runOf(a.parentAgentId, depth + 1)
    return this.currentRunId
  }

  /** agent.spawn resolved: the agent joins its spawner's run (main's current run, or its parent agent's). */
  spawned(input: { agentId: string; type: string; model: string; parentAgentId?: string; background: boolean; permissionMode?: string }) {
    const parent = input.parentAgentId ?? null
    const runId = parent !== null ? this.runOf(parent) : this.currentRunId
    const was = this.agents.get(input.agentId)
    this.agents.set(input.agentId, {
      agentId: input.agentId,
      runId,
      parentAgentId: parent,
      type: input.type || 'agent',
      model: input.model || was?.model || '',
      background: input.background,
      permissionMode: input.permissionMode ?? null,
      isOpen: was?.isOpen ?? false,
    })
    if (runId !== null) this.tasks.set(input.agentId, runId)
  }

  agentTurnStarted(input: { agentId: string; turnId: string; now: number }) {
    const a = this.agents.get(input.agentId)
    if (a) a.isOpen = true
    else {
      // Its spawn has not resolved yet: it most likely started in the current run; the spawn corrects it.
      this.agents.set(input.agentId, {
        agentId: input.agentId,
        runId: this.currentRunId,
        parentAgentId: null,
        type: 'agent',
        model: '',
        background: false,
        permissionMode: null,
        isOpen: true,
      })
    }
    this.loops.set(input.agentId, { key: input.agentId, agentId: input.agentId, turnId: input.turnId, startedAt: input.now, steps: [], tools: [], compactions: [] })
  }

  private loopFor(agentId: string | null | undefined, now: number, turnId = ''): Loop {
    const key = agentId ?? 'main'
    let loop = this.loops.get(key)
    if (!loop) {
      loop = { key, agentId: agentId ?? null, turnId, startedAt: now, steps: [], tools: [], compactions: [] }
      this.loops.set(key, loop)
      if (agentId) {
        const a = this.agents.get(agentId)
        if (a) a.isOpen = true
      }
    }
    return loop
  }

  // ---------------------------------------------------------------- model requests

  beginStep(input: { agentId?: string; turnId: string; index: number; model: string; effort?: Effort; now: number }): LiveStep {
    const loop = this.loopFor(input.agentId, input.now, input.turnId)
    const step: LiveStep = {
      loop: loop.key,
      agentId: input.agentId ?? null,
      index: input.index,
      startedAt: input.now,
      endedAt: null,
      firstAt: null,
      stopAt: null,
      model: input.model,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      usage: null,
      thinking: 0,
      stop: null,
    }
    if (loop.steps.length < MAX_STEPS) loop.steps.push(step)
    if (step.agentId === null) {
      const run = this.currentRun()
      if (run) run.stepsBegun += 1
      if (run && run.model === null) {
        run.model = input.model
        run.effort = input.effort ?? null
      }
    }
    return step
  }

  /** The stream ended (or was cut): the step's usage feeds the run's live total. */
  endStep(step: LiveStep, input: { now: number; usage: Usage | null; stop: StopReason }) {
    step.endedAt = input.now
    if (input.usage) step.usage = input.usage
    if (input.stop !== null) step.stop = input.stop
    const runId = step.agentId === null ? this.currentRunId : this.runOf(step.agentId)
    const run = runId === null ? undefined : this.runs.get(runId)
    if (!run) return
    if (step.agentId === null) run.mainSteps += 1
    if (step.usage) {
      const { usd } = costOf(step.usage.model || step.model, step.usage, { cacheWriteTtl: this.cfg.cacheWriteTtl })
      if (usd !== null) {
        run.liveUsd += usd
        run.pricedSteps += 1
      } else run.unpricedSteps += 1
    }
  }

  // ---------------------------------------------------------------- tools

  checked(toolUseId: string, decision: string) {
    this.checks.set(toolUseId, decision)
  }

  toolStarted(input: { id: string; agentId?: string; tool: string; input: unknown; now: number }) {
    // A main-loop call with no main turn open (a `!` command, another plugin's call) is no run's work, and opening a loop for it would keep the clock ticking while idle.
    if (!input.agentId && !this.loops.has('main') && !this.currentRun()?.isMainOpen) return
    const loop = this.loopFor(input.agentId, input.now)
    const runId = input.agentId ? this.runOf(input.agentId) : this.currentRunId
    const run = runId === null ? undefined : this.runs.get(runId)
    const isMain = !input.agentId
    const args = isObject(input.input) ? input.input : {}
    const info: LiveTool['info'] = {}
    const cwd = this.session?.cwd ?? ''
    const where = toolPath(input.tool, args)
    if (where) {
      const dir = folderOf(where.path, where.isDir, cwd)
      info.dir = dir
      if (run) pushCapped(EDIT_TOOLS.has(input.tool) ? run.editedDirs : run.readDirs, dir)
    }
    const lines = linesChanged(input.tool, args)
    if (lines) info.lines = lines
    if (SHELL_TOOLS.has(input.tool)) {
      const head = commandHead(args.command)
      if (head !== '') info.cmd = head
      if (args.run_in_background === true) info.background = true
    }
    if (AGENT_TOOLS.has(input.tool) && args.run_in_background === true) info.background = true
    if (input.tool === 'Skill' && typeof args.skill === 'string') {
      info.skill = args.skill
      if (isMain && run) {
        run.skills.push(args.skill)
        run.skillWork.push(run.workCalls)
      }
    } else if (isMain && run) {
      run.workCalls++
    }
    if (isMain && run && run.stepsBegun <= SHAPE_STEPS) run.earlyTools.push(input.tool)
    if ((input.tool === 'Agent' || input.tool === 'Task') && typeof args.subagent_type === 'string') info.agentType = args.subagent_type
    if (input.tool === 'TodoWrite' && Array.isArray(args.todos)) {
      const total = args.todos.length
      const done = args.todos.filter(t => isObject(t) && t.status === 'completed').length
      info.tasks = [done, total]
      if (run) run.tasks = { done, total }
    }
    if (run && input.tool === 'TaskCreate') run.tasks.total += 1
    if (run && input.tool === 'TaskUpdate') {
      if (args.status === 'completed') run.tasks.done += 1
      if (args.status === 'deleted') run.tasks.total = Math.max(0, run.tasks.total - 1)
    }
    const tool: LiveTool = {
      id: input.id,
      loop: loop.key,
      name: input.tool,
      startedAt: input.now,
      endedAt: null,
      failed: false,
      asked: false,
      dialog: false,
      runningAt: null,
      info,
    }
    this.liveTools.set(input.id, tool)
    if (loop.tools.length < MAX_TOOLS) loop.tools.push(tool)
  }

  toolEnded(input: { id: string; now: number; failed: boolean; backgroundTaskId?: string }) {
    const tool = this.liveTools.get(input.id)
    if (!tool) return
    this.liveTools.delete(input.id)
    tool.endedAt = input.now
    tool.failed = input.failed
    if (this.checks.get(input.id) === 'ask') tool.asked = true
    this.checks.delete(input.id)
    if (input.backgroundTaskId) {
      const loop = this.loops.get(tool.loop)
      const runId = loop?.agentId ? this.runOf(loop.agentId) : this.currentRunId
      if (runId !== null) this.tasks.set(input.backgroundTaskId, runId)
    }
  }

  /**
   * classic.PermissionRequest: a dialog put a call to the person. The hook
   * carries no tool_use_id, so the newest open call of that tool in that
   * loop is the one.
   */
  dialogShown(input: { tool: string; agentId?: string }) {
    const key = input.agentId ?? 'main'
    let found: LiveTool | undefined
    for (const t of this.liveTools.values()) if (t.endedAt === null && t.loop === key && t.name === input.tool && !t.dialog) found = t
    if (found) found.dialog = true
  }

  /** The call's progress row drew, so it runs: whoever was asked has answered. */
  toolRunning(toolUseId: string) {
    const t = this.liveTools.get(toolUseId)
    if (t && t.runningAt === null) t.runningAt = Math.max(t.startedAt, this.lastTick ?? t.startedAt)
  }

  /** The permission mode the loop runs under: the session's latest for the main loop. */
  private modeOf(loopKey: string): string | null {
    if (loopKey !== 'main') {
      const a = this.agents.get(loopKey)
      if (a?.permissionMode) return a.permissionMode
    }
    return this.permissionMode ?? this.currentRun()?.permissionMode ?? null
  }

  /**
   * Open and held by the person: a question or a plan to approve, or a call
   * put to a permission dialog. In auto mode an ask goes to the classifier
   * first, so it counts only once the dialog is shown.
   */
  isHeld(t: LiveTool): boolean {
    if (t.endedAt !== null) return false
    if (WAIT_TOOLS.has(t.name)) return true
    if (t.runningAt !== null || this.checks.get(t.id) !== 'ask') return false
    return t.dialog || this.modeOf(t.loop) !== 'auto'
  }

  /** The part of a call the person (or the auto-mode decider) held, as turnCompleted counts it. */
  private heldSpan(t: LiveTool, now: number): Span | null {
    if (WAIT_TOOLS.has(t.name)) return [t.startedAt, t.endedAt ?? now]
    if (t.endedAt !== null) {
      if (!t.asked) return null
      const ms = t.endedAt - t.startedAt
      const wait = t.runMs !== undefined ? Math.max(0, ms - t.runMs) : ms
      return wait > 0 ? [t.startedAt, t.startedAt + wait] : null
    }
    if (this.isHeld(t)) return [t.startedAt, now]
    if (t.runningAt !== null && this.checks.get(t.id) === 'ask') return [t.startedAt, t.runningAt]
    return null
  }

  /** The run's estimate at submit; replaced while its first two main requests settle the task. */
  setEstimate(runId: string, eta: StoredEta) {
    const run = this.runs.get(runId)
    if (run && (run.eta === null || run.mainSteps <= 2)) run.eta = eta
  }

  /** A step-time estimate of the whole run, made `atMs` of agent time in. */
  checkpoint(runId: string, mid: MidEta) {
    const run = this.runs.get(runId)
    if (!run || run.checkpoints.length >= MAX_CHECKPOINTS) return
    run.checkpoints.push(mid)
  }

  /** PostToolUse's duration_ms: the tool's own time, the permission prompt left out. */
  toolRan(toolUseId: string, durationMs: unknown) {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return
    for (const loop of this.loops.values()) {
      const tool = loop.tools.find(t => t.id === toolUseId)
      if (tool) {
        tool.runMs = Math.max(0, durationMs)
        return
      }
    }
  }

  compacted(input: { agentId?: string; trigger: string; before?: number; after?: number; now: number }) {
    if (input.trigger === 'precompute') return
    const entry: Compaction = {
      trigger: input.trigger,
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
    }
    const loop = this.loops.get(input.agentId ?? 'main')
    // Outside a turn no loop is opened (it would keep the clock ticking while idle): a main one waits for the next main turn.
    if (loop) loop.compactions.push(entry)
    else if (!input.agentId) this.pendingCompactions.push(entry)
  }

  // ---------------------------------------------------------------- the clock

  /** A one-second tick: a gap well past the period means the machine slept. */
  tick(now: number) {
    if (this.lastTick !== null && now - this.lastTick > this.cfg.sleepGapMs) {
      this.sleeps.push([this.lastTick + this.cfg.tickMs, now])
      if (this.sleeps.length > MAX_SLEEPS) this.sleeps = this.sleeps.slice(-MAX_SLEEPS)
    }
    this.lastTick = now
  }

  stopTicking() {
    this.lastTick = null
  }

  isIdle(): boolean {
    return this.loops.size === 0
  }

  // ---------------------------------------------------------------- the row

  taskFor(runId: string): RunTask | undefined {
    const run = this.runs.get(runId)
    if (!run) return undefined
    const c = classifyRun({
      skills: run.skills,
      skillWork: run.skillWork,
      projectsFolder: this.cfg.projectsFolder,
      command: run.command,
      editedPaths: run.editedDirs,
      readPaths: run.readDirs,
      ignore: this.cfg.ignoreSkills,
    })
    return { ...c, job: run.job, promptChars: run.promptChars, origin: run.origin, runStart: run.startedAt }
  }

  /** turn.complete: the loop's turn becomes one row. */
  turnCompleted(input: { agentId?: string; turnId: string; durationMs: number; reason: string; usage?: Usage; now: number }): TurnRow {
    const key = input.agentId ?? 'main'
    const loop = this.loops.get(key)
    this.loops.delete(key)
    const end = input.now
    const duration = Number.isFinite(input.durationMs) && input.durationMs > 0 ? input.durationMs : end - (loop?.startedAt ?? end)
    const start = end - duration
    const window: Span = [start, end]
    const agent = input.agentId ? this.agents.get(input.agentId) : undefined
    if (agent) agent.isOpen = false
    let runId = input.agentId ? this.runOf(input.agentId) : this.currentRunId
    if (runId === null) runId = this.openRun(null, start).id
    const run = this.runs.get(runId)
    if (!input.agentId && run) {
      run.isMainOpen = false
      run.endedAt = end
    }
    const ttl = { cacheWriteTtl: this.cfg.cacheWriteTtl }
    const at = (t: number) => Math.max(0, round(t - start))

    // Model requests.
    const steps: StepRow[] = (loop?.steps ?? []).map(s => {
      const stepEnd = s.endedAt ?? end
      const tokens = s.usage ? tokensOf(s.usage) : null
      const model = s.usage?.model || s.model
      const writing = s.firstAt !== null && s.stopAt !== null ? s.stopAt - s.firstAt : 0
      const row: StepRow = {
        at: at(s.startedAt),
        model,
        ...(s.effort !== undefined ? { effort: s.effort } : {}),
        ms: round(stepEnd - s.startedAt),
        firstTokenMs: s.firstAt === null ? null : round(s.firstAt - s.startedAt),
        tokensPerSec: tokens && writing >= 100 ? Math.round((tokens.output / (writing / 1000)) * 10) / 10 : null,
        tokens,
        usd: s.usage ? roundUsd(costOf(model, s.usage, ttl).usd) : null,
        ...(s.thinking > 0 ? { thinkingChars: s.thinking } : {}),
        stop: s.stop,
      }
      return row
    })

    // Tool calls, with the time the person held each.
    const waitSpans: Span[] = []
    const runSpans: Span[] = []
    const tools: ToolRow[] = (loop?.tools ?? []).map(t => {
      this.liveTools.delete(t.id)
      const toolEnd = t.endedAt ?? end
      const ms = Math.max(0, toolEnd - t.startedAt)
      const isWaitTool = WAIT_TOOLS.has(t.name)
      const asked = t.asked || isWaitTool
      const waitMs = isWaitTool ? ms : asked ? (t.runMs !== undefined ? Math.max(0, ms - t.runMs) : ms) : 0
      if (waitMs > 0) waitSpans.push([t.startedAt, t.startedAt + waitMs])
      if (ms - waitMs > 0) runSpans.push([t.startedAt + waitMs, toolEnd])
      const row: ToolRow = {
        at: at(t.startedAt),
        name: t.name,
        ms: round(ms),
        ...(t.runMs !== undefined ? { runMs: round(t.runMs) } : {}),
        ...(waitMs > 0 ? { waitMs: round(waitMs) } : {}),
        ...(asked ? { asked: true as const } : {}),
        ...(t.failed ? { error: true as const } : {}),
        ...(t.endedAt === null ? { cut: true as const } : {}),
        ...t.info,
      }
      return row
    })

    // Where the time went.
    const sleepIn = clip(this.sleeps, window)
    const sleepMs = lengthOf(sleepIn)
    const waitMs = lengthOf(subtract(clip(waitSpans, window), this.sleeps))
    const stepSpans: Span[] = (loop?.steps ?? []).map(s => [s.startedAt, s.endedAt ?? end])
    const modelMs = lengthOf(subtract(clip(stepSpans, window), this.sleeps))
    const toolMs = lengthOf(subtract(clip(runSpans, window), this.sleeps))
    const agentMs = Math.max(0, duration - waitMs - sleepMs)

    // What it cost: the engine's turn usage, else the requests' own (an interrupted turn has none).
    const model = input.usage?.model || steps[steps.length - 1]?.model || agent?.model || ''
    let tokens: Tokens
    let usd: number | null
    let isUnpriced = false
    if (input.usage) {
      tokens = tokensOf(input.usage)
      const cost = costOf(model, input.usage, ttl)
      usd = cost.usd
      isUnpriced = cost.unpriced
    } else {
      tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      usd = 0
      for (const s of steps) {
        if (!s.tokens) continue
        tokens.input += s.tokens.input
        tokens.output += s.tokens.output
        tokens.cacheRead += s.tokens.cacheRead
        tokens.cacheWrite += s.tokens.cacheWrite
        if (s.usd === null) isUnpriced = true
        else if (usd !== null) usd += s.usd
      }
      if (isUnpriced) usd = null
    }

    // Conditions.
    const first = steps[0]?.tokens ?? null
    const firstInput = first ? first.input + first.cacheRead + first.cacheWrite : 0
    const startDate = new Date(start)
    const compactions = loop?.compactions ?? []
    const cond: Conditions = {
      contextStart: run?.contextStart ?? null,
      contextTurn: first ? firstInput : null,
      cache: first === null || firstInput === 0 ? null : first.cacheRead / firstInput >= 0.5 ? 'warm' : 'cold',
      hour: startDate.getHours(),
      weekday: startDate.getDay(),
      tzOffsetMin: startDate.getTimezoneOffset(),
      permissionMode: agent?.permissionMode ?? run?.permissionMode ?? this.permissionMode,
      version: this.session?.version ?? null,
      cwdName: this.session?.cwdName ?? '',
      ...(compactions.length > 0 ? { compactions } : {}),
    }

    const effort = loop?.steps.find(s => s.effort !== undefined)?.effort ?? null
    const task = this.taskFor(runId) ?? { taskType: 'freeform', skill: null, command: null, project: null, job: null, promptChars: 0, origin: 'unknown', runStart: start }
    const row: TurnRow = {
      v: 1,
      kind: 'turn',
      src: 'live',
      machineId: this.session?.machineId ?? '',
      sessionId: this.session?.sessionId ?? '',
      runId,
      turnId: input.turnId,
      agentId: input.agentId ?? null,
      parentAgentId: agent?.parentAgentId ?? null,
      agentType: input.agentId ? (agent?.type ?? 'agent') : null,
      background: input.agentId ? (agent?.background ?? false) : null,
      model,
      effort,
      start: round(start),
      end: round(end),
      ms: round(duration),
      agentMs: round(agentMs),
      modelMs: round(modelMs),
      toolMs: round(toolMs),
      waitMs: round(waitMs),
      sleepMs: round(sleepMs),
      outcome: outcomeOf(input.reason),
      tokens,
      usd: roundUsd(usd),
      ...(isUnpriced ? { unpriced: true as const } : {}),
      steps: steps.map(s => {
        const { model: m, effort: x, ...rest } = s
        return { ...rest, ...(m !== model ? { model: m } : {}), ...(x !== undefined && x !== effort ? { effort: x } : {}) }
      }),
      tools,
      ...(sleepIn.length > 0 ? { sleeps: sleepIn.map(([a, b]) => [at(a), round(b - a)] as [number, number]) } : {}),
      errors: {
        tools: tools.filter(t => t.error).length,
        steps: steps.filter(s => s.tokens === null && s.stop === null).length,
      },
      task,
      cond,
    }

    // The run's running totals: its waits, who did what, and the estimate it began with.
    if (run) {
      run.waitSpans.push(...clip(waitSpans, window))
      if (run.waitSpans.length > MAX_WAIT_SPANS) run.waitSpans = run.waitSpans.slice(-MAX_WAIT_SPANS)
      const inAgentsMs = tools.filter(t => AGENT_TOOLS.has(t.name) && !t.background).reduce((s, t) => s + Math.max(0, t.ms - (t.waitMs ?? 0)), 0)
      if (run.done.length < MAX_DONE) {
        run.done.push({
          key,
          agentId: input.agentId ?? null,
          type: row.agentType,
          model,
          ms: round(Math.max(0, agentMs - inAgentsMs)),
          tokens: tokens.input + tokens.cacheWrite + tokens.output,
          cost: row.usd === null ? { usd: 0, priced: 0, unpriced: 1 } : { usd: row.usd, priced: 1, unpriced: 0 },
        })
      }
      if (!input.agentId) {
        run.closedToolMs += tools.filter(t => !AGENT_TOOLS.has(t.name)).reduce((s, t) => s + Math.max(0, t.ms - (t.waitMs ?? 0)), 0)
        if (run.eta) row.eta = run.eta
        const half = this.runTimes(run, end).agentMs / 2
        let mid: MidEta | undefined
        for (const c of run.checkpoints) if (!mid || Math.abs(c.atMs - half) < Math.abs(mid.atMs - half)) mid = c
        if (mid) row.etaMid = { atMs: round(mid.atMs), usualMs: round(mid.usualMs), slowMs: round(mid.slowMs) }
      }
    }
    this.pruneSleeps()
    if (!input.agentId) this.pruneRuns()
    return row
  }

  /**
   * Drops finished runs past the newest KEEP_RUNS, with their closed agents
   * and task ids, so a session of thousands of runs holds a bounded amount.
   * A run with a loop still working or an agent still open is kept.
   */
  pruneRuns() {
    const finished = [...this.runs.values()].filter(r => !r.isMainOpen && r.id !== this.currentRunId)
    if (finished.length <= KEEP_RUNS) return
    const busy = new Set<string>()
    for (const a of this.agents.values()) if (a.isOpen && a.runId !== null) busy.add(a.runId)
    for (const loop of this.loops.values()) {
      const id = loop.agentId === null ? this.currentRunId : this.runOf(loop.agentId)
      if (id !== null) busy.add(id)
    }
    const gone = new Set<string>()
    for (const run of finished.slice(0, finished.length - KEEP_RUNS)) {
      if (busy.has(run.id)) continue
      this.runs.delete(run.id)
      gone.add(run.id)
    }
    if (gone.size === 0) return
    for (const [id, a] of this.agents) if (!a.isOpen && a.runId !== null && gone.has(a.runId)) this.agents.delete(id)
    for (const [task, runId] of this.tasks) if (gone.has(runId)) this.tasks.delete(task)
    for (const id of this.checks.keys()) if (!this.liveTools.has(id)) this.checks.delete(id)
  }

  private pruneSleeps() {
    let oldest = Infinity
    for (const loop of this.loops.values()) oldest = Math.min(oldest, loop.startedAt)
    if (oldest === Infinity) this.sleeps = []
    else this.sleeps = this.sleeps.filter(s => s[1] >= oldest)
  }

  // ---------------------------------------------------------------- what the band and the pane draw

  /** The loops working for the run now. */
  private loopsOf(run: Run): Loop[] {
    const out: Loop[] = []
    for (const loop of this.loops.values()) {
      const id = loop.agentId === null ? this.currentRunId : this.runOf(loop.agentId)
      if (id === run.id) out.push(loop)
    }
    return out
  }

  /** Where the run's time went so far: wall less sleep, the person's holds, and the rest. */
  private runTimes(run: Run, now: number): { end: number; elapsedMs: number; waitMs: number; agentMs: number } {
    const end = run.isMainOpen ? now : (run.endedAt ?? now)
    const window: Span = [run.startedAt, end]
    const sleepMs = overlapMs(this.sleeps, window)
    const held: Span[] = [...run.waitSpans]
    for (const loop of this.loopsOf(run)) {
      for (const t of loop.tools) {
        const span = this.heldSpan(t, end)
        if (span) held.push(span)
      }
    }
    const waitMs = lengthOf(subtract(clip(held, window), this.sleeps))
    const elapsedMs = Math.max(0, end - run.startedAt - sleepMs)
    return { end, elapsedMs, waitMs, agentMs: Math.max(0, elapsedMs - waitMs) }
  }

  /** An open loop's share so far, as turnCompleted will count it. */
  private openPart(run: Run, loop: Loop, now: number): WhoPart & { isOpen: boolean } {
    const agent = loop.agentId ? this.agents.get(loop.agentId) : undefined
    const out: Span[] = [...this.sleeps]
    for (const t of loop.tools) {
      const span = this.heldSpan(t, now)
      if (span) out.push(span)
      if (AGENT_TOOLS.has(t.name) && !t.info.background) out.push([t.startedAt, t.endedAt ?? now])
    }
    let tokens = 0
    const cost: Cost = { usd: 0, priced: 0, unpriced: 0 }
    let model = ''
    for (const s of loop.steps) {
      model = s.usage?.model || s.model || model
      if (!s.usage) continue
      const t = tokensOf(s.usage)
      tokens += t.input + t.cacheWrite + t.output
      const usd = costOf(s.usage.model || s.model, s.usage, { cacheWriteTtl: this.cfg.cacheWriteTtl }).usd
      if (usd !== null) {
        cost.usd += usd
        cost.priced += 1
      } else cost.unpriced += 1
    }
    if (loop.agentId === null) model = run.model ?? model
    else model = agent?.model || model
    return {
      key: loop.key,
      agentId: loop.agentId,
      type: loop.agentId ? (agent?.type ?? 'agent') : null,
      model,
      ms: round(lengthOf(subtract([[loop.startedAt, now]], out))),
      tokens,
      cost,
      isOpen: true,
    }
  }

  /** The running run as the band and the pane need it: elapsed, holds, cost so far, what runs now, who is working. */
  liveView(now: number): LiveView | null {
    const run = this.currentRun()
    if (!run) return null
    const times = this.runTimes(run, now)
    const loops = this.loopsOf(run)
    const held = loops.some(l => l.tools.some(t => this.isHeld(t)))
    const main = run.isMainOpen ? this.loops.get('main') : undefined
    const openTool = main ? [...main.tools].reverse().find(t => t.endedAt === null) : undefined
    const openStep = main ? [...main.steps].reverse().find(s => s.endedAt === null) : undefined
    const agents = [...this.agents.values()].filter(a => a.runId === run.id).map(a => ({ agentId: a.agentId, type: a.type, model: a.model, isOpen: a.isOpen, background: a.background }))

    // Who did what: the finished turns' parts and the open loops', one entry per loop.
    const byKey = new Map<string, WhoPart & { isOpen: boolean }>()
    const add = (p: WhoPart & { isOpen: boolean }) => {
      const was = byKey.get(p.key)
      if (!was) byKey.set(p.key, { ...p, cost: { ...p.cost } })
      else {
        was.ms += p.ms
        was.tokens += p.tokens
        was.cost = { usd: was.cost.usd + p.cost.usd, priced: was.cost.priced + p.cost.priced, unpriced: was.cost.unpriced + p.cost.unpriced }
        was.isOpen = was.isOpen || p.isOpen
        if (p.model) was.model = p.model
      }
    }
    for (const p of run.done) add({ ...p, isOpen: false })
    for (const loop of loops) add(this.openPart(run, loop, now))

    // The main loop's tool time so far, Agent calls and holds left out.
    let toolMs = run.closedToolMs
    for (const t of main?.tools ?? []) {
      if (AGENT_TOOLS.has(t.name)) continue
      const span = this.heldSpan(t, now)
      const heldMs = span ? span[1] - span[0] : 0
      toolMs += Math.max(0, (t.endedAt ?? now) - t.startedAt - heldMs)
    }

    // The main loop's writing speed and cache, from its requests this run.
    const recentTps: number[] = []
    let cache: 'warm' | 'cold' | null = null
    for (const s of main?.steps ?? []) {
      if (!s.usage) continue
      const t = tokensOf(s.usage)
      const prompt = t.input + t.cacheRead + t.cacheWrite
      if (prompt > 0) cache = t.cacheRead / prompt >= 0.5 ? 'warm' : 'cold'
      const writing = s.firstAt !== null && s.stopAt !== null ? s.stopAt - s.firstAt : 0
      if (writing >= 100 && t.output > 0) recentTps.push(Math.round((t.output / (writing / 1000)) * 10) / 10)
    }

    let nowPart: LiveView['now'] = null
    if (openTool) {
      const i = openTool.info
      nowPart = { kind: 'tool', name: openTool.name, detail: i.cmd ?? i.agentType ?? i.skill ?? i.dir ?? '', sinceMs: Math.max(0, now - openTool.startedAt) }
    } else if (openStep) {
      nowPart = { kind: 'model', name: familyOf(openStep.model), detail: openStep.firstAt === null ? 'thinking' : 'writing', sinceMs: Math.max(0, now - openStep.startedAt) }
    }

    return {
      runId: run.id,
      task: this.taskFor(run.id),
      isWorking: run.isMainOpen || agents.some(a => a.isOpen),
      isMainOpen: run.isMainOpen,
      startedAt: run.startedAt,
      elapsedMs: times.elapsedMs,
      waitMs: times.waitMs,
      agentMs: times.agentMs,
      toolMs: round(toolMs),
      cost: { usd: run.liveUsd, priced: run.pricedSteps, unpriced: run.unpricedSteps },
      mainSteps: run.mainSteps,
      shape: run.stepsBegun > SHAPE_STEPS ? shapeOf(run.earlyTools) : null,
      model: run.model,
      effort: run.effort,
      promptChars: run.promptChars,
      tasks: run.tasks,
      isWaitingOnYou: held,
      now: nowPart,
      agents,
      who: [...byKey.values()],
      recentTps,
      cache,
    }
  }
}
