import type { On, RenderElement } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { isReportFile, reportRefusal, safeReportPath } from '../hooks/commands'

// The band and the pane through the engine: a scripted session whose past
// runs sit on disk (live and backfilled), the plugin's own hooks recording a
// run as it goes, and the drawings read back as the person would read them.
// The clock is the world's, moved by the scripted model and tools and by
// one-second ticks the test lets through (never more than four seconds
// apart, so no gap reads as machine sleep).

const T0 = new Date(2026, 9, 18, 12, 0, 0).getTime()
const DAY = 86_400_000
const CWD = '/vault'
const DIR = '/vault/.vault-eta/runs/mbeef0001'
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'
const PANE = 'vault-eta'

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type Script = { firstMs: number; writeMs: number; usage: Usage | null }
type Gate = { wait: Promise<void>; open: () => void }
type PaneRow = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

type World = {
  now: number
  files: Map<string, string>
  nowCalls: number
  ticks: Array<() => void>
  steps: Script[]
  toolMs: Record<string, number>
  gates: Record<string, Gate>
  asks: Set<string>
  mode: string
  opened: Array<Record<string, unknown>>
  closed: string[]
  panes: PaneRow[]
  placed: boolean
  toasts: string[]
  /** Symbolic links: the path, and the absolute path it leads to. */
  links: Map<string, string>
  dirs: Set<string>
}

const usage = (input: number, cacheWrite: number, cacheRead: number, output: number): Usage => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
})

function newWorld(): World {
  return { now: T0, files: new Map(), nowCalls: 0, ticks: [], steps: [], toolMs: {}, gates: {}, asks: new Set(), mode: 'acceptEdits', opened: [], closed: [], panes: [], placed: true, toasts: [], links: new Map(), dirs: new Set([CWD]) }
}

function gate(): Gate {
  let open = () => {}
  const wait = new Promise<void>(r => (open = r))
  return { wait, open }
}

/** A past run's main row, as the recorder or the backfill wrote it. */
function pastRow(i: number, taskType: string, seconds: number, src: 'live' | 'backfill') {
  // website-work runs overlap, so none ended before another began: the replay has nothing to score them with, and the seeded figures stay uncorrected
  const start = T0 - 2 * DAY + i * (taskType === 'freeform' ? 3_600_000 : 1000)
  const ms = seconds * 1000
  return {
    v: 1,
    kind: 'turn',
    src,
    machineId: 'mbeef0001',
    sessionId: src === 'live' ? 'old' : `bf${i}`,
    runId: `past-${taskType}-${i}`,
    turnId: `pt${i}`,
    agentId: null,
    model: OPUS,
    effort: 'high',
    start,
    end: start + ms,
    ms,
    agentMs: ms,
    modelMs: ms * 0.7,
    toolMs: ms * 0.3,
    waitMs: 0,
    sleepMs: 0,
    outcome: 'finished',
    tokens: { input: 40, output: 400, cacheRead: 4000, cacheWrite: 0 },
    usd: 0.5,
    steps: Array.from({ length: 4 }, () => ({ at: 0, ms: 1000, firstTokenMs: null, tokensPerSec: src === 'live' ? 100 : null, tokens: null, usd: null, stop: 'tool_use' })),
    tools: [],
    task: { taskType, skill: taskType === 'freeform' ? null : taskType, command: null, project: taskType === 'website-work' ? 'website' : null, job: null, promptChars: 100, origin: 'composer', runStart: start },
  }
}

/**
 * Ten website-work runs of 60 to 150 s (usual 105 s, slow 132 s), half
 * live and half backfilled, and three freeform runs (learning, 3 of 5).
 */
function seedHistory(world: World) {
  const live: string[] = []
  const backfill: string[] = []
  for (let i = 0; i < 10; i++) (i % 2 === 0 ? live : backfill).push(JSON.stringify(pastRow(i, 'website-work', 60 + i * 10, i % 2 === 0 ? 'live' : 'backfill')))
  for (let i = 0; i < 3; i++) backfill.push(JSON.stringify(pastRow(20 + i, 'freeform', 30, 'backfill')))
  world.files.set(`${DIR}/2026-10-16-old.jsonl`, `${live.join('\n')}\n`)
  world.files.set(`${DIR}/backfill-2026-10.jsonl`, `${backfill.join('\n')}\n`)
}

function listDir(files: Map<string, string>, dir: string) {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const cut = rest.indexOf('/')
    names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
  }
  return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
}

const MODEL_BY_NAME: Record<string, string> = { sonnet: SONNET, haiku: HAIKU }

function engine(on: On, world: World, below?: RenderElement, store: Record<string, unknown> = { machineId: 'mbeef0001' }) {
  // the store is the caller's object, so a test can read what /eta job kept
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('clock.now', () => {
    world.nowCalls += 1
    return { value: world.now }
  })
  on('clock.every', () => new Promise(resolve => world.ticks.push(() => resolve({ value: undefined }))))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 's1' }))
  on('session.version', () => ({ value: { version: '2.1.302' } }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { tokens: 42_000, window: 1_000_000, percent: 4 }, rateLimits: [], cost: { usd: 1 } } }))
  // a link is followed, as the engine's own file system does
  const real = (path: string) => {
    for (const [from, to] of world.links) {
      if (path === from) return to
      if (path.startsWith(`${from}/`)) return to + path.slice(from.length)
    }
    return path
  }
  on('fs.write', ($, e) => {
    world.files.set(real(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = world.files.get(real(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    const target = real(e.path)
    const isFile = world.files.has(target)
    const isDir = world.dirs.has(target) || [...world.files.keys()].some(k => k.startsWith(`${target}/`))
    const isLink = world.links.has(e.path)
    if (!isFile && !isDir && !isLink) throw new Error(`ENOENT: ${e.path}`)
    const kind = isFile ? ('file' as const) : isDir ? ('dir' as const) : ('other' as const)
    return { value: { kind, size: 0, mtimeMs: 0, isLink, ...(e.resolve && (isFile || isDir) ? { realPath: target } : {}) } }
  })
  on('fs.list', ($, e) => ({ value: listDir(world.files, e.path) }))
  on('fs.exists', ($, e) => ({ value: [...world.files.keys()].some(k => k === e.path || k.startsWith(`${e.path}/`)) }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: world.panes }))
  on('ui.open', ($, e) => {
    world.opened.push({ ...e })
    if (!world.panes.some(p => p.id === e.id)) world.panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: world.placed })
    else world.panes = world.panes.map(p => (p.id === e.id ? { ...p, isPlaced: true } : p))
    return { value: world.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'unasked below 144 columns' } }
  })
  on('ui.close', ($, e) => {
    world.closed.push(e.id)
    world.panes = world.panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => below ?? ({ type: 'Box', props: {}, children: [] } as never))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.check', ($, e) => ({ decision: world.asks.has(e.tool_use_id ?? '') ? ('ask' as const) : ('allow' as const) }))
  on('agent.spawn', ($, e) => ({ model: MODEL_BY_NAME[e.description] ?? HAIKU, agentId: `agent-${e.description}` }))
  on('tool.call', async ($, e) => {
    const id = e.tool_use_id ?? ''
    const held = world.gates[id]
    if (held) await held.wait
    world.now += world.toolMs[id] ?? 100
    return { result: {} as never, text: 'ok' }
  })
  on('turn.step', async function* ($, e) {
    const s = world.steps.shift() ?? { firstMs: 500, writeMs: 500, usage: usage(10, 0, 9000, 50) }
    world.now += s.firstMs
    yield { kind: 'text' as const, index: 0, text: 'ok' }
    world.now += s.writeMs
    const u = s.usage ? { ...s.usage, model: e.model } : null
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: u }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: u }
  })
}

type Timers = { setTimeout: (fn: () => void, ms: number) => unknown }
const pause = (ms: number) => new Promise<void>(r => (globalThis as unknown as Timers).setTimeout(r, ms))

/** Lets the plugin finish what it does after a hook answered: the view refresh and the log writes. */
const settle = () => pause(25)

/** Lets one held tick through after `ms`, and waits until the plugin has drawn its view for it. */
async function tick(world: World, ms: number) {
  for (let i = 0; i < 200 && world.ticks.length === 0; i++) await pause(2)
  world.now += ms
  const before = world.nowCalls
  const release = world.ticks.shift()
  expect(release).toBeDefined()
  release?.()
  for (let i = 0; i < 200 && world.nowCalls < before + 2; i++) await pause(2)
  await pause(8)
}

/** Moves the clock in ticks 2.5 s apart at most, so no gap (with the scripted moves between) reads as sleep. */
async function advance(world: World, ms: number) {
  for (let rest = ms; rest > 0; rest -= 2500) await tick(world, Math.min(2500, rest))
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

async function prompt($: Engine, world: World, text: string, promptId: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: text, prompt_id: promptId, permission_mode: world.mode, source: 'user' } as never)
}

async function drain(stream: AsyncGenerator<unknown, unknown>) {
  for (;;) {
    const n = await stream.next()
    if (n.done) return n.value
  }
}

const step = ($: Engine, turnId: string, index: number, model = OPUS, agentId?: string) =>
  drain($.turn.step({ turnId, index, model, effort: 'high', messageCount: index + 1, ...(agentId ? { agentId } : {}) } as never) as never)

async function complete($: Engine, world: World, turnId: string, startedAt: number, agentId?: string) {
  const result = await $.turn.complete({ answer: 'done', durationMs: world.now - startedAt, isAborted: false, reason: 'answer', turnId, ...(agentId ? { agentId } : {}) } as never)
  await settle()
  return result
}

/** A website-work run under way: one request, then the skill that names it. */
async function beginRun($: Engine, world: World, promptId = 'p1') {
  await prompt($, world, 'build the onboarding flow', promptId)
  const t0 = world.now
  await $.turn.start({ text: 'build the onboarding flow', turnId: `m-${promptId}` } as never)
  await step($, `m-${promptId}`, 0)
  await $.tool.call({ tool: 'Skill', skill: 'website-work', tool_use_id: `k-${promptId}` } as never)
  return t0
}

// The drawn tree as the person reads it: a row's Texts joined, a column's rows on lines.
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  const el = node as { type?: string; props?: { children?: unknown; flexDirection?: string }; children?: unknown }
  const kids = el.children ?? el.props?.children
  if (el.type === 'Box' && el.props?.flexDirection === 'column') return (Array.isArray(kids) ? kids : [kids]).map(textOf).join('\n')
  return textOf(kids)
}

/** The Texts of a tree in order, with their props. */
function texts(node: unknown, out: Array<{ text: string; props: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) for (const n of node) texts(n, out)
  else if (node && typeof node === 'object') {
    const el = node as { type?: string; props?: Record<string, unknown> & { children?: unknown }; children?: unknown }
    if (el.type === 'Text') out.push({ text: textOf(el), props: el.props ?? {} })
    else texts(el.children ?? el.props?.children, out)
  }
  return out
}

const BAND = { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 165, scroll: { offset: 0, bodyRows: 8 }, view: {} }
const WIDE = { columns: 170, rows: 50, isFullscreen: true }

async function bandTree($: Engine, opts: { bodyColumns?: number; viewport?: { columns: number; rows: number; isFullscreen: boolean }; hasSurvey?: boolean; surface?: 'terminal' | 'desktop' } = {}) {
  await settle()
  const ui = await $.ui.mount({
    plugin: 'vault-eta',
    surface: opts.surface ?? 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, bodyColumns: opts.bodyColumns ?? 165, hasSurvey: opts.hasSurvey ?? false },
    viewport: opts.viewport ?? WIDE,
  })
  const tree = await ui.drawn()
  await ui.unmount()
  return tree
}

const band = async ($: Engine, opts: Parameters<typeof bandTree>[1] = {}) => textOf(await bandTree($, opts))

async function pane($: Engine, bodyColumns = 46, surface: 'terminal' | 'desktop' = 'terminal') {
  await settle()
  const ui = await $.ui.mount({
    plugin: 'vault-eta',
    surface,
    component: 'Pane',
    requestId: PANE,
    props: { title: 'ETA', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: WIDE,
  })
  const text = textOf(await ui.drawn())
  await ui.unmount()
  // an empty line is drawn as one space
  return text.split('\n').map(line => line.trimEnd())
}

const eta = ($: Engine, args = '') => $.command.run({ command: 'eta', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 170 } })

function rowsOf(world: World): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  for (const [path, text] of world.files) {
    if (!path.includes('-s1.jsonl')) continue
    for (const line of text.split('\n')) if (line.trim() !== '') out.push(JSON.parse(line))
  }
  return out.filter(r => r.kind === 'turn')
}

describe('the band', () => {
  test('idle at session start: the last run and today, learned from live and backfilled rows', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) expect(await band($, { surface }), surface).toBe('last freeform 0:30 · today $0.00')
    await eta($)
    const lines = await pane($)
    expect(lines).toContain('learned from 13 past runs (90 days)')
  })

  test('working: learning before the skill names the run, then a countdown that turns warning and error', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    await prompt($, world, 'build the onboarding flow', 'p1')
    await $.turn.start({ text: 'build the onboarding flow', turnId: 'm1' } as never)
    expect(await band($)).toBe('learning (3 of 5) · 0:00 in · $0.00 · freeform')
    expect(texts(await bandTree($))[0]?.props).toMatchObject({ dimColor: true })

    await step($, 'm1', 0)
    await $.tool.call({ tool: 'Skill', skill: 'website-work', tool_use_id: 'k1' } as never)
    // 1.1 s in: the survivors say 104 s more, one step of the usual four says 3 s (half weight)
    expect(await band($)).toBe('~1m left · 0:01 in · <$0.01 · website-work')
    expect(texts(await bandTree($))[0]?.props).toMatchObject({ color: 'success' })

    await advance(world, 119_000) // 2:00 in: past the usual 1:45, short of the slow 2:12
    expect(await band($)).toBe('~2m left · 2:00 in · <$0.01 · website-work')
    expect(texts(await bandTree($))[0]?.props).toMatchObject({ color: 'warning' })

    await advance(world, 20_000) // 2:20 in: past the slow figure
    expect(await band($)).toBe('over usual · 2:20 in · <$0.01 · website-work')
    expect(texts(await bandTree($))[0]?.props).toMatchObject({ color: 'error', bold: true })
  })

  test('waiting on you replaces the countdown and pauses it: a question, an asked call, and in auto mode only a dialog', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    await beginRun($, world)
    await advance(world, 10_000)
    const before = await band($)
    expect(before).toMatch(/^~\dm left · 0:11 in/)

    // a question is open for 30 s: the countdown gives way, the elapsed time holds
    world.gates.q1 = gate()
    const question = $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q1' } as never)
    await pause(10)
    await advance(world, 30_000)
    expect(await band($)).toMatch(/^waiting on you · 0:11 in · /)
    expect(texts(await bandTree($))[0]?.props).toMatchObject({ color: 'warning', bold: true })
    world.gates.q1.open()
    await question
    expect(await band($)).toMatch(/^~\dm left · 0:11 in/)

    // an asked call outside auto mode waits on the person
    // the engine's own check says allow (a test has no one to ask); the ask the plugin sees is the test's own tool.check
    world.gates.b1 = gate()
    const asked = $.tool.call({ tool: 'Bash', command: 'git fetch', tool_use_id: 'b1' } as never)
    await pause(10)
    world.asks.add('b1')
    await $.tool.check({ tool: 'Bash', input: { command: 'git fetch' }, tool_use_id: 'b1' } as never)
    await advance(world, 4000)
    expect(await band($)).toMatch(/^waiting on you/)
    world.gates.b1.open()
    await asked

    // in auto mode an ask goes to the classifier first: waiting only once the dialog shows
    world.mode = 'auto'
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'x', duration_ms: 1, permission_mode: 'auto' } as never)
    world.gates.b2 = gate()
    const auto = $.tool.call({ tool: 'Bash', command: 'bun run build', tool_use_id: 'b2' } as never)
    await pause(10)
    world.asks.add('b2')
    await $.tool.check({ tool: 'Bash', input: { command: 'bun run build' }, tool_use_id: 'b2' } as never)
    await advance(world, 2000)
    expect(await band($)).toMatch(/^~\dm left/)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'bun run build' } } as never)
    expect(await band($)).toMatch(/^waiting on you/)
    world.gates.b2.open()
    await auto
    expect(await band($)).toMatch(/^~\dm left/)
  })

  test('next(e): a band beneath is kept, above this row; a survey leaves the band beneath alone', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world, { type: 'Text', props: {}, children: ['ctx 41% │ cache 60m │ $18.42'] } as never)
    await start($)
    expect(await band($)).toBe('ctx 41% │ cache 60m │ $18.42\nlast freeform 0:30 · today $0.00')
    expect(await band($, { hasSurvey: true })).toBe('ctx 41% │ cache 60m │ $18.42')
  })

  test('a narrow terminal drops the task, then the cost, then the elapsed time', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    await beginRun($, world)
    await advance(world, 30_000)
    const full = await band($)
    expect(full).toMatch(/^~\dm left · 0:31 in · <\$0\.01 · website-work$/)
    const countdown = full.split(' · ')[0] ?? ''
    expect(await band($, { bodyColumns: full.length })).toBe(full)
    expect(await band($, { bodyColumns: 30 })).toBe(`${countdown} · 0:31 · <$0.01`.replace(' left', ''))
    expect(await band($, { bodyColumns: 12 })).toBe(`${countdown.replace(' left', '')} · 0:31`)
    expect(await band($, { bodyColumns: 4 })).toBe(countdown.replace(' left', ''))
  })
})

describe('the pane', () => {
  test('/eta opens and closes it at any width and prints nothing; a pane waiting for room is seated, not closed', async ($, on) => {
    const world = newWorld()
    engine(on, world)
    await start($)
    const opened = await eta($)
    expect(opened.text).toBeUndefined()
    expect(world.opened).toEqual([expect.objectContaining({ id: PANE, title: 'ETA', columns: 48 })])
    const closed = await eta($)
    expect(closed.text).toBeUndefined()
    expect(world.closed).toEqual([PANE])

    world.panes = [{ id: PANE, title: 'ETA', isShown: false, isFocused: false, isPlaced: false }]
    await eta($)
    expect(world.closed).toEqual([PANE])
    expect(world.opened.length).toBe(2)
    await eta($, 'close')
    expect(world.closed).toEqual([PANE, PANE])

    expect((await eta($, 'bogus')).text).toBeUndefined()
    expect(world.toasts.at(-1)).toMatch(/^\/eta: open, close, report, job <name>, job end\.$/)
  })

  test('/eta job: set (sanitized), show, end with the totals; nothing reaches the model', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    // a past run already tagged with the job, so its totals have something to add up
    const tagged = pastRow(30, 'freeform', 30, 'live')
    ;(tagged.task as { job: string | null }).job = 'my-build'
    world.files.set(`${DIR}/2026-10-17-tagged.jsonl`, `${JSON.stringify(tagged)}\n`)
    const store: Record<string, unknown> = { machineId: 'mbeef0001' }
    engine(on, world, undefined, store)
    await start($)

    expect((await eta($, 'job')).text).toBeUndefined()
    expect(world.toasts.at(-1)).toBe('no job set. /eta job <name> tags the runs after it.')
    await eta($, 'job end')
    expect(world.toasts.at(-1)).toBe('no job set.')

    expect((await eta($, 'job  My Build!')).text).toBeUndefined()
    expect(world.toasts.at(-1)).toBe('job my-build: runs are tagged until /eta job end')
    expect(store.job).toBe('my-build')
    // the pane header shows it at once (the idle view carries the job)
    await eta($)
    expect(await pane($)).toContain('job       my-build 1 run · 0:30 · $0.50')

    await eta($, 'job')
    expect(world.toasts.at(-1)).toBe('job my-build: 1 run, 30s, $0.500 at API prices')

    await eta($, 'job end')
    expect(world.toasts.at(-1)).toBe('job my-build ended: 1 run, 30s, $0.500 at API prices')
    expect(store.job).toBeUndefined()
    await eta($, 'job')
    expect(world.toasts.at(-1)).toMatch(/^no job set/)

    // sanitizing: lowercase, a-z 0-9 and hyphens, 40 characters at most, nothing usable is refused
    await eta($, `job ${'Alpha_Beta Gamma '.repeat(5)}`)
    const stored = String(store.job)
    expect(stored).toMatch(/^[a-z0-9-]{1,40}$/)
    // cut at 40 characters, then a trailing hyphen dropped
    expect(stored).toBe('alpha-beta-gamma-alpha-beta-gamma-alpha')
    await eta($, 'job end')
    await eta($, 'job !!!')
    expect(world.toasts.at(-1)).toMatch(/needs letters or numbers/)
    expect(store.job).toBeUndefined()
  })

  test('/eta report writes the note to the report file and toasts where', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    expect((await eta($, 'report')).text).toBeUndefined()
    expect(world.toasts.at(-1)).toBe('report written: /vault/vault-eta-report.md')
    const note = world.files.get('/vault/vault-eta-report.md') ?? ''
    expect(note).toMatch(/^---\ntype: reference\n/)
    expect(note).toContain('## Totals')
    expect(note).toContain('| website-work | 10 |')
    expect(note.includes('\u2014')).toBe(false)
  })

  test('the report path stays inside the folder: relative, .md, no .. or drive or hidden folders', () => {
    expect(safeReportPath('/vault', 'vault-eta-report.md')).toBe('/vault/vault-eta-report.md')
    expect(safeReportPath('/vault', 'notes\\Reports/eta.MD')).toBe('/vault/notes/Reports/eta.MD')
    for (const bad of ['', '/etc/passwd.md', '../out.md', 'a/../../out.md', 'C:\\x.md', '~/x.md', 'x.txt', 'CLAUDE', '.git/hooks/x.md', '.vault-eta/x.md', 'a:b.md']) {
      expect(safeReportPath('/vault', bad)).toBe(null)
    }
  })

  test('a new log folder ignores itself', async ($, on) => {
    const fresh = newWorld()
    engine(on, fresh)
    await start($)
    expect(fresh.files.get('/vault/.vault-eta/.gitignore')).toBe('*\n')
  })

  test('a log folder with no ignore file gets one, also when it is deleted mid-session; one its owner emptied is left as it is', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    expect(world.files.get('/vault/.vault-eta/.gitignore')).toBe('*\n')

    // the person deletes the folder while the session runs: the next write makes it again, ignore file first
    for (const path of [...world.files.keys()]) if (path.startsWith('/vault/.vault-eta/')) world.files.delete(path)
    const t0 = await beginRun($, world)
    await complete($, world, 'm-p1', t0)
    expect(world.files.get('/vault/.vault-eta/.gitignore')).toBe('*\n')
    expect([...world.files.keys()].some(path => path.endsWith('-s1.jsonl'))).toBe(true)

    world.files.set('/vault/.vault-eta/.gitignore', '')
    const t1 = await beginRun($, world, 'p2')
    await complete($, world, 'm-p2', t1)
    expect(world.files.get('/vault/.vault-eta/.gitignore')).toBe('')
  })

  test('/eta report never writes through a symbolic link or over a note it did not write; it rewrites its own', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)

    world.files.set('/home/me/.zshrc', 'export PATH=/bin\n')
    world.links.set('/vault/vault-eta-report.md', '/home/me/.zshrc')
    await eta($, 'report')
    expect(world.toasts.at(-1)).toBe('/eta report not written: vault-eta-report.md is a symbolic link')
    expect(world.files.get('/home/me/.zshrc')).toBe('export PATH=/bin\n')

    world.links.clear()
    world.files.set('/vault/vault-eta-report.md', '# My own note\n')
    await eta($, 'report')
    expect(world.toasts.at(-1)).toBe('/eta report not written: vault-eta-report.md exists and was not written by vault-eta (move it, or set reportPath)')
    expect(world.files.get('/vault/vault-eta-report.md')).toBe('# My own note\n')

    world.files.delete('/vault/vault-eta-report.md')
    await eta($, 'report')
    expect(world.toasts.at(-1)).toBe('report written: /vault/vault-eta-report.md')
    const first = world.files.get('/vault/vault-eta-report.md') ?? ''
    expect(isReportFile(first)).toBe(true)
    world.files.set('/vault/vault-eta-report.md', first.replace('## Totals', '## Totals (old)'))
    await eta($, 'report')
    expect(world.toasts.at(-1)).toBe('report written: /vault/vault-eta-report.md')
    expect(world.files.get('/vault/vault-eta-report.md')).toBe(first)
  })

  test('the report path may not lead outside the folder through a linked folder', async () => {
    const files = new Map<string, string>([['/elsewhere/x', '']])
    const links = new Map([['/vault/notes', '/elsewhere']])
    const real = (p: string) => {
      for (const [from, to] of links) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length)
      return p
    }
    const $ = {
      fs: {
        stat: async (path: string, options?: { resolve: boolean }) => {
          const target = real(path)
          const isDir = target === '/vault' || target === '/elsewhere' || target === '/vault/inside'
          if (!isDir && !files.has(target)) throw new Error('ENOENT')
          return { kind: isDir ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: links.has(path), ...(options?.resolve ? { realPath: target } : {}) }
        },
        read: async (path: string) => files.get(real(path)) ?? '',
      },
    } as never
    expect(await reportRefusal($, '/vault', '/vault/notes/eta.md')).toBe('notes leads outside the folder')
    expect(await reportRefusal($, '/vault', '/vault/inside/new/deeper/eta.md')).toBe(null)
    expect(isReportFile('---\ntype: reference\ntags: [vault-eta, report]\ngenerated: true\n---\n# x')).toBe(true)
    expect(isReportFile('---\ntags: [vault-eta, report]\n---\n# x')).toBe(false)
  })

  test('a linked .vault-eta stops the log of the session with one toast; nothing is written or read through it', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    // the seeded history now sits elsewhere, reached only through the link
    for (const [path, text] of [...world.files]) {
      world.files.delete(path)
      world.files.set(path.replace('/vault/.vault-eta', '/home/me/elsewhere'), text)
    }
    world.links.set('/vault/.vault-eta', '/home/me/elsewhere')
    engine(on, world)
    await start($)
    expect(world.toasts.filter(t => t.startsWith('vault-eta is not logging'))).toEqual(['vault-eta is not logging this session: .vault-eta is a symbolic link'])
    // not read either: nothing learned from the linked folder
    expect(await band($)).toBe('vault-eta: no runs logged yet · today $0.00')
    const before = new Map(world.files)
    const t0 = await beginRun($, world)
    await complete($, world, 'm-p1', t0)
    expect(world.files).toEqual(before)
    expect(world.toasts.filter(t => t.startsWith('vault-eta is not logging')).length).toBe(1)
    await eta($, 'report')
    expect(world.toasts.at(-1)).toBe('/eta report not written: .vault-eta is a symbolic link')
    expect(world.files.has('/vault/vault-eta-report.md')).toBe(false)
  })

  test('a log file that is a link (one leading nowhere) is never written through', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    world.links.set(`${DIR}/2026-10-18-s1.jsonl`, '/home/me/.bashrc')
    engine(on, world)
    await start($)
    expect(world.toasts).toEqual([])
    const t0 = await beginRun($, world)
    await complete($, world, 'm-p1', t0)
    expect(world.files.has('/home/me/.bashrc')).toBe(false)
    expect(world.toasts.at(-1)).toBe('vault-eta is not logging this session: .vault-eta/runs/mbeef0001/2026-10-18-s1.jsonl is a symbolic link')
  })

  test('/eta report asked while a run works is written once it ends, so it never stalls the turn', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    const t0 = await beginRun($, world)
    await eta($, 'report')
    expect(world.toasts.at(-1)).toBe('/eta report: written when this run ends')
    expect(world.files.has('/vault/vault-eta-report.md')).toBe(false)
    await complete($, world, 'm-p1', t0)
    await pause(20)
    expect(world.toasts.at(-1)).toBe('report written: /vault/vault-eta-report.md')
    expect(world.files.has('/vault/vault-eta-report.md')).toBe(true)
  })

  test('opens by itself when a run starts on a wide fullscreen terminal; not narrow, not on the main screen, not once closed', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)

    await band($, { viewport: { columns: 120, rows: 50, isFullscreen: true } })
    const t1 = await beginRun($, world, 'p1')
    await pause(10)
    expect(world.opened.length).toBe(0)
    await step($, 'm-p1', 1)
    await complete($, world, 'm-p1', t1)

    await band($, { viewport: { columns: 170, rows: 50, isFullscreen: false } })
    const t2 = await beginRun($, world, 'p2')
    await pause(10)
    expect(world.opened.length).toBe(0)
    await complete($, world, 'm-p2', t2)

    await band($, { viewport: WIDE })
    const t3 = await beginRun($, world, 'p3')
    await pause(10)
    expect(world.opened).toEqual([expect.objectContaining({ id: PANE, columns: 48 })])
    await complete($, world, 'm-p3', t3)

    // closed (by /eta here; the person's close mark raises the same ui.close): the next run leaves it shut
    await eta($, 'close')
    expect(world.closed).toEqual([PANE])
    const t4 = await beginRun($, world, 'p4')
    await pause(10)
    expect(world.opened.length).toBe(1)
    await complete($, world, 'm-p4', t4)
  })

  test('a run with two subagents: header, progress, time left, NOW, WHO, the split, speed, context and cost', async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    await eta($)
    // main writes 31 tokens in half a second: 62 tok/s against the usual 100
    world.steps.push({ firstMs: 500, writeMs: 500, usage: usage(10, 0, 9000, 31) })
    await prompt($, world, 'build the onboarding flow', 'p1')
    await $.turn.start({ text: 'build the onboarding flow', turnId: 'm1' } as never)
    await step($, 'm1', 0)
    await $.tool.call({ tool: 'Skill', skill: 'website-work', tool_use_id: 'k1' } as never)

    for (const name of ['sonnet', 'haiku']) {
      await $.agent.spawn({ prompt: name, description: name, subagentType: 'general-purpose', background: false, tool_use_id: `t-${name}` } as never)
      const at = world.now
      await $.turn.start({ text: name, turnId: `x-${name}`, agentId: `agent-${name}` } as never)
      world.steps.push({ firstMs: 200, writeMs: 200, usage: usage(2000, 1000, 0, 500) })
      await step($, `x-${name}`, 0, MODEL_BY_NAME[name] ?? HAIKU, `agent-${name}`)
      await complete($, world, `x-${name}`, at, `agent-${name}`)
    }

    world.gates.b1 = gate()
    const build = $.tool.call({ tool: 'Bash', command: 'cd /vault && bun run build --secret-flag', tool_use_id: 'b1' } as never)
    await pause(10)
    await advance(world, 41_000)
    const lines = await pane($)
    // 42.9 s in: 1.9 s of requests and the skill, then the build's 41 s
    expect(lines[0]).toBe('website-work · website')
    expect(lines[1]).toMatch(/^█+░+  0:42 of ~2:4\d$/)
    expect(lines[2]).toBe('~2m left    usual 2m · slow 2m')
    expect(lines[3]).toBe('10 past runs · not scored yet')
    expect(lines[4]).toBe('')
    expect(lines[5]).toBe(`NOW  Bash  bun run build${' '.repeat(12)}0:41`)
    expect(lines[7]).toBe('WHO            time   tokens     cost')
    expect(lines[8]).toBe(`main   opus    0:42${'41'.padStart(9)}${'<$0.01'.padStart(9)}`)
    expect(lines[9]).toBe(`sonnet x1      0:00${'3.5k'.padStart(9)}${'$0.01'.padStart(9)}`)
    expect(lines[10]).toBe(`haiku  x1      0:00${'3.5k'.padStart(9)}${'<$0.01'.padStart(9)}`)
    expect(lines[12]).toBe('agent 0:01 · tools 0:41 · waiting on you 0')
    // 62 tok/s against the usual 100, on the model's 70% share of the time: +43%
    expect(lines[13]).toBe('speed 62 tok/s (usual 100) · eta +43%')
    expect(lines[14]).toBe('context 42.0k · cache warm')
    expect(lines[15]).toBe('$0.02 so far · at API prices')
    expect(lines.join('\n').includes('secret')).toBe(false)
    for (const line of lines) expect([...line].length).toBeLessThan(47)

    world.gates.b1.open()
    await build
    await step($, 'm1', 1)
    await complete($, world, 'm1', T0)
    const idle = await pane($)
    expect(idle[0]).toBe('vault-eta · idle')
    expect(idle[2]).toBe('last run  website-work 0:44 · est 2m · on time')
    expect(idle).toContain('/eta report  history and accuracy')
  })
})

describe('the estimate on the row', () => {
  test("the estimate at submit is kept on the run's main row, with the step-time estimate nearest halfway", async ($, on) => {
    const world = newWorld()
    seedHistory(world)
    engine(on, world)
    await start($)
    const t0 = await beginRun($, world)
    await advance(world, 20_000)
    await step($, 'm-p1', 1)
    await advance(world, 20_000)
    await step($, 'm-p1', 2)
    await complete($, world, 'm-p1', t0)
    const [row] = rowsOf(world)
    expect(row?.eta).toMatchObject({ taskType: 'website-work', project: 'website', model: OPUS, level: 'type+project+model', n: 10, learning: null, usualMs: 105_000, slowMs: 132_000, factor: 1 })
    expect(row?.etaMid?.atMs).toBeGreaterThan(10_000)
    expect(row?.etaMid?.usualMs).toBeGreaterThan(row?.etaMid?.atMs)
    expect(await band($)).toMatch(/^last website-work 0:4\d \(est 2m, on time\) · today <\$0\.01$/)
  })
})
