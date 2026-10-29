import { atom, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnStepResult } from 'claude-code'

import { resolveBase } from '../lib/base.mjs'
import { SUBMIT_STEPS, isPersonPrompt, parseList } from '../lib/classify.mjs'
import { canImport, projectsRoot } from '../lib/coldstart.mjs'
import type { EtaView } from '../types'
import { registerBand } from './band'
import { JOB_KEY, backfillCommand, fsOf, jobCommand, jobName, reportCommand, scorecardCommand } from './commands'
import { refusalOf } from './guard'
import { LOG_ROOT, SessionLog, WriteRefused, ensureGitignore, flushLog, joinPath, loadRecent, localDate, reloadLog } from './log'
import { autoOpen, paneCommand, registerCommand, registerPane } from './pane'
import { Profile, estimateRun, storedEta } from './predict'
import { Recorder } from './record'
import type { LiveStep } from './record'
import { idleView, workingView } from './view'

// vault-eta: times every model request and tool call of every run, tags each
// with its agent and model, prices it at API prices, and writes one row per
// turn to `.vault-eta/runs/` in the session's folder. From the last 90 days of
// those rows (backfill included) it estimates each run as it goes and draws
// the estimate in a band above the prompt and a side pane, /eta toggling the
// pane. The mod never calls a model and never adds text to the prompt.
//
// Every hook passes its event on unchanged and returns what is beneath it.
// The view refresh and the log writes never hold a hook: they run after it,
// a refresh at a time and the writes one after another on a chain.

type Engine = EngineInterface

export const TICK_MS = 1000
/** A tick this late means the machine slept (or the host froze): that time is not agent time. */
export const SLEEP_GAP_MS = 5000
const MACHINE_KEY = 'machineId'
/** The machine id's form (`m` and eight hex digits): it names a folder, so anything else is replaced. */
export const MACHINE_ID = /^m[0-9a-f]{8}$/

/** What the band and the pane draw; this file writes it, they only read it. */
const viewAtom = atom({ plugin: 'vault-eta', key: 'view' } as const, { kind: 'none' } as EtaView)

/** Chunks that carry the model's own output; `engine` chunks (the envelope, block starts) do not. */
const CONTENT_CHUNKS = new Set(['text', 'thinking', 'tool', 'input'])

// Module state: a reload runs register again, so these start over with it
// (the session's log is read back from disk at the next session.start).
let rec = new Recorder({ cacheWriteTtl: '1h', ignoreSkills: [], projectsFolder: '', tickMs: TICK_MS, sleepGapMs: SLEEP_GAP_MS })
let log: SessionLog | undefined
let cwd = ''
let machineId = ''
let version: string | null = null
let reportPath = 'vault-eta-report.md'
let ignoreSkills: string[] = []
let projectsFolder = ''
/** True while the log has no runs and Claude Code kept transcripts for this folder: the band says how to import them. */
let importable = false
let timer: Timer | undefined
let isTicking = false
let profile = new Profile()
/** The terminal as the band last measured it: the pane opens by itself only where it lands as a sidebar. */
let viewport: { columns: number; isFullscreen: boolean | undefined } | null = null
let lastView = ''
let refreshing: Promise<void> | null = null
let refreshAgain = false
let refreshSince = 0
const REFRESH_STALE_MS = 5000
/** Per run, the main request count its last step-time checkpoint was made at. */
const checkpointed = new Map<string, number>()
/** Bumped at every register: work started under an older one (a reload) drops its result. */
let generation = 0
/** The log writes, one after another. */
let flushChain: Promise<void> = Promise.resolve()
/** `/eta report` asked while the main loop worked: written when it next goes idle, so it never stalls a turn. */
let isReportWaiting = false
/** Why this session writes no log (a symbolic link in `.vault-eta`, or a path that leads outside the folder); null while it may. */
let logBlocked: string | null = null
/** The latest run's opening (its context, its job, a new log after /clear): turn.start does not wait for it, its turn's end does. */
let pendingOpen: Promise<void> = Promise.resolve()

function newMachineId(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.()
  const hex = uuid ? uuid.replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16)
  return `m${hex.slice(0, 8)}`
}

function stopTicker() {
  timer?.cancel()
  timer = undefined
  rec.stopTicking()
}

/**
 * The view the band and the pane draw: the running run's estimate while any
 * of its loops works (its subagents' time is run time, so the clock goes on
 * after the main loop hands work to a background agent), else the idle summary.
 */
async function refreshOnce($: Engine, gen: number) {
  const now = await $.clock.now()
  if (gen !== generation) return
  const live = rec.liveView(now)
  let view: EtaView
  if (live && live.isWorking) {
    const est = estimateRun(profile, live)
    if (live.mainSteps <= SUBMIT_STEPS) rec.setEstimate(live.runId, storedEta(est, live.mainSteps))
    if (est.leftMs !== null && est.leftSlowMs !== null && checkpointed.get(live.runId) !== live.mainSteps) {
      checkpointed.set(live.runId, live.mainSteps)
      rec.checkpoint(live.runId, { atMs: live.agentMs, usualMs: live.agentMs + est.leftMs, slowMs: live.agentMs + est.leftSlowMs })
    }
    const usage = await $.session.usage().catch(() => undefined)
    view = workingView(live, est, { contextTokens: usage?.context.tokens ?? null })
  } else {
    // Nothing of the run works: the self-score catches up with the rows that came in.
    profile.refreshScores()
    const job = jobName(await $.store.get(JOB_KEY).catch(() => undefined))
    view = idleView(profile, now, job, importable)
  }
  if (gen !== generation) return
  const text = JSON.stringify(view)
  if (text === lastView) return
  await update($, viewAtom, () => view)
  lastView = text
}

/**
 * Rebuilds the view; a call while one runs makes it run once more. One stuck
 * past five seconds (a dispatch abandoned under it) is left behind, so the
 * band never freezes on it. Hooks call it without waiting (`void`): it never
 * rejects, and nothing a hook answers waits on it.
 */
function refreshView($: Engine): Promise<void> {
  if (refreshing && Date.now() - refreshSince < REFRESH_STALE_MS) {
    refreshAgain = true
    return refreshing
  }
  refreshSince = Date.now()
  const gen = generation
  const mine = (async () => {
    try {
      do {
        refreshAgain = false
        await refreshOnce($, gen)
      } while (refreshAgain && gen === generation)
    } catch {
      // the view stays as last drawn; the next tick or event rebuilds it
    }
  })()
  refreshing = mine
  void mine.then(() => {
    if (refreshing === mine) refreshing = null
  })
  return mine
}

/** The process environment, for the folders the mod reads (the backfill's transcripts). */
function envOf(): { CLAUDE_CONFIG_DIR?: string; HOME?: string; USERPROFILE?: string } {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}

/** The last 90 days of rows, backfill included, as the profile estimates learn from; scored here, before the first run. */
async function loadProfile($: Engine) {
  const next = new Profile()
  // a log folder that leads elsewhere is not read either
  if (logBlocked !== null) {
    profile = next
    importable = false
    return
  }
  try {
    next.load(await loadRecent($, cwd, await $.clock.now()), rec.session?.sessionId ?? '')
    next.score()
  } catch {
    // an empty profile: every run shows learning until its kind has five runs
  }
  profile = next
  // the hint is only for a log with no runs; one look at session start and after an import
  importable = next.history.length + next.session.length === 0 && (await canImport(fsOf($), cwd, projectsRoot(envOf())).catch(() => false))
}

async function onTick($: Engine, gen: number) {
  if (isTicking || gen !== generation) return
  isTicking = true
  try {
    rec.tick(await $.clock.now())
    await refreshView($)
    if (rec.isIdle()) stopTicker()
  } catch {
    stopTicker()
  } finally {
    isTicking = false
  }
}

/** One tick a second while any loop works; a late tick is machine sleep. */
function startTicker($: Engine, now: number) {
  if (timer) return
  rec.tick(now)
  const gen = generation
  timer = $.clock.every(TICK_MS, () => void onTick($, gen))
}

/** The log for this session id; after a /clear the id changes and a new file starts. */
async function logFor($: Engine, sessionId: string, now: number): Promise<SessionLog> {
  if (log && log.sessionId === sessionId) return log
  const next = new SessionLog(joinPath(cwd, LOG_ROOT, machineId), localDate(now), sessionId)
  if (logBlocked === null) await reloadLog($, next)
  next.markBaseline((await $.session.usage().catch(() => undefined))?.cost?.usd ?? null)
  log = next
  rec.setSessionId(sessionId)
  return next
}

/** Stops this session's logging, with one toast saying why. */
function blockLog($: Engine, reason: string) {
  if (logBlocked !== null) return
  logBlocked = reason
  $.ui.toast(`vault-eta is not logging this session: ${reason}`, { timeoutMs: 8000 })
}

/**
 * Writes a log's new rows, and the ignore file first if it has gone missing.
 * Nothing new, nothing written. Every path goes through the shared write
 * rule: a symbolic link at `.vault-eta`, `runs`, the machine folder or the
 * file, or a path that resolves outside the folder, stops the session's log.
 */
async function flush($: Engine, target: SessionLog | undefined) {
  if (logBlocked !== null || !target || !target.isDirty()) return
  const refused = await ensureGitignore($, cwd)
  if (refused !== null) return blockLog($, refused)
  const usage = await $.session.usage().catch(() => undefined)
  try {
    await flushLog(
      $,
      target,
      runId => rec.taskFor(runId),
      { machineId, now: await $.clock.now(), engineUsd: usage?.cost?.usd ?? null, version },
      path => refusalOf($, cwd, path),
    )
  } catch (error) {
    if (error instanceof WriteRefused) blockLog($, error.message)
    else throw error
  }
}

/** Queues a flush of the log as it is now on the write chain; the promise never rejects. */
function queueFlush($: Engine, target: SessionLog | undefined = log): Promise<void> {
  const gen = generation
  flushChain = flushChain.then(() => (gen === generation ? flush($, target) : undefined)).catch(() => undefined)
  return flushChain
}

/**
 * The folder `.vault-eta/` sits in. The session's project root (a shell `cd`
 * does not move it) leads; the event's cwd is the fallback. Resolved again on
 * every session.start, so a reload from a subfolder gives the same answer.
 */
async function baseFolder($: Engine, eventCwd: string): Promise<string> {
  const root = await $.session.root().catch(() => '')
  const start = root !== '' ? root : eventCwd
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  // Windows has USERPROFILE where macOS and Linux have HOME
  const home = env?.HOME ?? env?.USERPROFILE
  return resolveBase(start, {
    home,
    namesIn: async dir => {
      try {
        return (await $.fs.list(dir)).map(e => e.name)
      } catch {
        return null
      }
    },
  }).catch(() => start)
}

async function startSession($: Engine, sessionCwd: string) {
  cwd = await baseFolder($, sessionCwd)
  const now = await $.clock.now()
  const stored = await $.store.get(MACHINE_KEY)
  machineId = typeof stored === 'string' && MACHINE_ID.test(stored) ? stored : newMachineId()
  if (stored !== machineId) await $.store.set(MACHINE_KEY, machineId)
  version = await $.session
    .version()
    .then(v => v.version)
    .catch(() => null)
  const sessionId = await $.session.id()
  const refused = await ensureGitignore($, cwd)
  if (refused !== null) blockLog($, refused)
  rec.startSession({ machineId, sessionId, cwd, version, now })
  await logFor($, sessionId, now)
}

/** A run opened: the context it starts with, the job in force, and a new file after a /clear. Runs after turn.start answered. */
async function openRun($: Engine, runId: string, now: number) {
  if (!rec.session) return
  const sessionId = await $.session.id()
  if (sessionId !== rec.session.sessionId) {
    // the old log is queued with its rows as they are; the new one takes over at once
    void queueFlush($, log)
    await logFor($, sessionId, now)
  }
  const usage = await $.session.usage().catch(() => undefined)
  const job = jobName(await $.store.get(JOB_KEY).catch(() => undefined))
  rec.setRunContext(runId, { contextStart: usage?.context.tokens ?? null, job })
}

/** Writes the report now, or once the main loop is idle when a turn is running (so it never stalls one). */
async function report($: Engine) {
  if (rec.loops.has('main')) {
    isReportWaiting = true
    $.ui.toast('/eta report: written when this run ends', { timeoutMs: 6000 })
    return
  }
  isReportWaiting = false
  // a log folder that leads elsewhere is not read for the report either
  if (logBlocked !== null) {
    $.ui.toast(`/eta report not written: ${logBlocked}`, { timeoutMs: 6000 })
    return
  }
  await reportCommand($, cwd, profile, reportPath)
}

/** Reads the clock, or the fallback when the dispatch was abandoned. */
async function nowOr($: Engine, fallback: number): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return fallback
  }
}

export const register: Register = (on, options) => {
  generation += 1
  flushChain = Promise.resolve()
  isReportWaiting = false
  pendingOpen = Promise.resolve()
  logBlocked = null
  rec = new Recorder({
    cacheWriteTtl: options.cacheWriteTtl === '5m' ? '5m' : '1h',
    ignoreSkills: parseList(typeof options.ignoreSkills === 'string' ? options.ignoreSkills : ''),
    projectsFolder: typeof options.projectsFolder === 'string' ? options.projectsFolder.trim() : '',
    tickMs: TICK_MS,
    sleepGapMs: SLEEP_GAP_MS,
  })
  log = undefined
  timer = undefined
  isTicking = false
  profile = new Profile()
  viewport = null
  lastView = ''
  refreshing = null
  refreshAgain = false
  refreshSince = 0
  checkpointed.clear()

  registerBand(on, {
    onViewport: (columns, isFullscreen) => {
      viewport = { columns, isFullscreen }
    },
  })
  ignoreSkills = parseList(typeof options.ignoreSkills === 'string' ? options.ignoreSkills : '')
  projectsFolder = typeof options.projectsFolder === 'string' ? options.projectsFolder.trim() : ''
  importable = false
  reportPath = typeof options.reportPath === 'string' && options.reportPath.trim() !== '' ? options.reportPath.trim() : 'vault-eta-report.md'
  registerPane(on)

  // /eta prints nothing: the pane, the report and the job tag each answer in a toast.
  on('command.run', { command: 'eta' }, async ($, e) => {
    try {
      const words = (e.args ?? '').trim().split(/\s+/).filter(Boolean)
      const verb = words[0]?.toLowerCase() ?? ''
      if (verb === 'report') await report($)
      else if (verb === 'scorecard') {
        if (logBlocked !== null) $.ui.toast(`/eta scorecard not written: ${logBlocked}`, { timeoutMs: 6000 })
        else await scorecardCommand($, cwd, profile)
      }
      else if (verb === 'backfill') {
        const done = await backfillCommand($, { cwd, machine: machineId, root: projectsRoot(envOf()), ignore: ignoreSkills, projectsFolder, blocked: logBlocked })
        if (done) {
          await loadProfile($)
          void refreshView($)
        }
      }
      else if (verb === 'job') {
        if (await jobCommand($, profile, words.slice(1).join(' '))) void refreshView($)
      } else await paneCommand($, verb)
    } catch {
      // the command answers nothing either way
    }
    return {}
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await registerCommand($).catch(() => undefined)
    await startSession($, e.cwd).catch(() => undefined)
    await loadProfile($)
    void refreshView($)
    return result
  })

  // The engine's end step first; then, inside the same short bound, any rows not on disk yet.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.reason === 'clear') stopTicker()
      if (log?.isDirty()) void queueFlush($)
      await flushChain
    } catch {
      // the rows not written are lost; the session is not
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      rec.promptSubmitted({ origin: e.origin.kind, isMidTurn: e.turnId !== undefined, text: e.text, command: e.command?.name ?? null })
    } catch {
      // recorded nothing
    }
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      rec.classicPrompt({
        ...(e.prompt_id ? { promptId: e.prompt_id } : {}),
        ...(e.permission_mode ? { permissionMode: e.permission_mode } : {}),
      })
    } catch {
      // recorded nothing
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      if (e.agentId === undefined) {
        const opened = rec.mainTurnStarted({ turnId: e.turnId, text: e.text, now })
        if (opened) {
          pendingOpen = openRun($, opened.id, now).catch(() => undefined)
          if (isPersonPrompt({ kind: opened.origin })) void autoOpen($, viewport).catch(() => undefined)
        }
      } else rec.agentTurnStarted({ agentId: e.agentId, turnId: e.turnId, now })
      startTicker($, now)
      void refreshView($)
    } catch {
      // recorded nothing
    }
    return next(e)
  })

  // A streaming hook: each chunk passes through as it arrives, so the first
  // token and the stop chunk are timed where they happen.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await nowOr($, Date.now())
    let step: LiveStep | undefined
    try {
      step = rec.beginStep({
        ...(e.agentId ? { agentId: e.agentId } : {}),
        turnId: e.turnId,
        index: e.index,
        model: e.model,
        ...(e.effort !== undefined ? { effort: e.effort } : {}),
        now: startedAt,
      })
    } catch {
      step = undefined
    }
    let result: TurnStepResult | undefined
    let stopUsage: TurnStepResult['usage'] = null
    let stopReason: string | null = null
    try {
      const stream = next(e)
      for await (const chunk of stream) {
        if (step) {
          try {
            if (step.firstAt === null && CONTENT_CHUNKS.has(chunk.kind)) step.firstAt = await $.clock.now()
            if (chunk.kind === 'thinking') step.thinking += chunk.text.length
            if (chunk.kind === 'stop') {
              step.stopAt = await $.clock.now()
              stopUsage = chunk.usage
              stopReason = chunk.stopReason
            }
          } catch {
            // this chunk's timing is lost; the chunk is not
          }
        }
        yield chunk
      }
      result = await stream.result
      return result
    } finally {
      if (step) {
        try {
          const end = await nowOr($, step.stopAt ?? step.firstAt ?? step.startedAt)
          rec.endStep(step, { now: end, usage: result?.usage ?? stopUsage, stop: result?.stopReason ?? stopReason })
        } catch {
          // the step is left unfinished in the record
        }
        // Re-estimate after every step, without holding the response.
        void refreshView($)
      }
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    try {
      if (e.tool_use_id) rec.checked(e.tool_use_id, verdict.decision)
      if (verdict.decision === 'ask') void refreshView($)
    } catch {
      // recorded nothing
    }
    return verdict
  })

  // A permission dialog put a call to the person (in auto mode, the classifier could not settle it).
  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      rec.dialogShown({ tool: e.tool_name, ...(e.agent_id ? { agentId: e.agent_id } : {}) })
      void refreshView($)
    } catch {
      // recorded nothing
    }
    return next(e)
  })

  // A running call's progress row: the call runs, so its dialog has been answered.
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    try {
      rec.toolRunning(e.props.tool_use_id)
    } catch {
      // recorded nothing
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const startedAt = await nowOr($, Date.now())
    const id = e.tool_use_id ?? `${tool}:${startedAt}`
    try {
      rec.toolStarted({ id, ...(e.agentId ? { agentId: e.agentId } : {}), tool, input: e, now: startedAt })
      void refreshView($)
    } catch {
      // recorded nothing
    }
    let failed = true
    let backgroundTaskId: string | undefined
    try {
      const result = await next(e)
      failed = result.deny !== undefined || result.isError === true
      const record = result.result as { backgroundTaskId?: unknown } | undefined
      if (typeof record === 'object' && record !== null && typeof record.backgroundTaskId === 'string') backgroundTaskId = record.backgroundTaskId
      return result
    } finally {
      try {
        const end = await nowOr($, startedAt)
        rec.toolEnded({ id, now: end, failed, ...(backgroundTaskId ? { backgroundTaskId } : {}) })
      } catch {
        // the call stays open in the record until its turn ends
      }
      void refreshView($)
    }
  })

  on('classic.PostToolUse', async ($, e, next) => {
    try {
      rec.toolRan(e.tool_use_id, e.duration_ms)
      rec.noteMode(e.permission_mode)
    } catch {
      // recorded nothing
    }
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    try {
      rec.toolRan(e.tool_use_id, e.duration_ms)
    } catch {
      // recorded nothing
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.agentId) {
        rec.spawned({
          agentId: result.agentId,
          type: e.subagentType,
          model: result.model,
          ...(e.parentAgentId ? { parentAgentId: e.parentAgentId } : {}),
          background: e.background,
          ...(e.permissionMode ? { permissionMode: e.permissionMode } : {}),
        })
      }
    } catch {
      // recorded nothing
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.skip === undefined) {
        rec.compacted({
          ...(e.agentId ? { agentId: e.agentId } : {}),
          trigger: e.trigger,
          ...(result.tokensBefore !== undefined ? { before: result.tokensBefore } : {}),
          ...(result.tokensAfter !== undefined ? { after: result.tokensAfter } : {}),
          now: await $.clock.now(),
        })
      }
    } catch {
      // recorded nothing
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      // long done by now in practice (a model request came between); a row must not land in the log a /clear left behind
      await pendingOpen
      const row = rec.turnCompleted({
        ...(e.agentId ? { agentId: e.agentId } : {}),
        turnId: e.turnId,
        durationMs: e.durationMs,
        reason: e.reason,
        ...(e.usage ? { usage: e.usage } : {}),
        now: await $.clock.now(),
      })
      if (log) {
        log.add(row, runId => rec.taskFor(runId))
        // A run ends with its main turn; a late agent's row is saved when the main loop is idle.
        if (e.agentId === undefined || !rec.loops.has('main')) void queueFlush($)
      }
      profile.addRow({ ...row, task: rec.taskFor(row.runId) ?? row.task })
      for (const id of checkpointed.keys()) if (!rec.runs.has(id)) checkpointed.delete(id)
      void refreshView($)
      if (rec.isIdle()) stopTicker()
      if (isReportWaiting && !rec.loops.has('main')) void report($).catch(() => undefined)
    } catch {
      // the row is lost, the turn is not
    }
    return result
  })
}
