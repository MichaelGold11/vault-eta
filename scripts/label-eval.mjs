#!/usr/bin/env node
// Scores how the run labels and the matching keys hold up, by replay: every
// logged run is estimated from only the runs that ended before it started.
//
//   node scripts/label-eval.mjs --vault ~/notes [--ignore "kickoff, triage"] [--projects-folder Work/Projects] [--steps 3,5,8]
//
// Three setups are compared on the same rows. "legacy" is what vault-eta did
// before: no helper skills skipped, a run with no project detected matching
// only runs that had none, no shape key. "matching" is the lib's matching as
// it is now (project and shape only when known) with legacy labels, and
// "current" adds the generic helper skills. Each is scored in the states an
// estimate really has, and one it never has:
//
//   final   the run's own labels known, which only the finished run has, so
//           no estimate at submit does (the report's and scorecard's "once the
//           labels are known" figure)
//   submit  only what the first estimate has: the slash command, prompt size,
//           model and effort (no skill, no folder, no shape yet)
//   kept    the estimate kept as the run's estimate at submit, refreshed
//           through its first two requests: the skills loaded and folders
//           touched in them, no shape (the report's and scorecard's figure
//           at submit, which read the label each live run kept)
//   steps k after k model requests: the skills loaded so far, the folders
//           touched so far and, from the third request, the shape; the matches
//           still going give the time left (history part of the estimate only)
//
// A table splits the current setup's submit and step figures by the run's
// shape (answer, read, shell, edit, agents), with a 95% interval on coverage.
// The last repeats the step figures on the same rows with the subagent-aware
// estimate (lib/stats remainingWithAgents) wherever the run had agents going
// when that request began, and counts those rows.
//
// Every time is on the run clock (lib/aggregate runClock), the one the band
// counts: the main loop and its subagents, background ones included, parallel
// ones once, waits on the person and sleep left out. The time gone at a step
// is that clock up to the step's start, from the run's own rows. Rows that
// cannot be placed on the clock add their stored time; the first line counts them.
//
// Typical miss is exp(median |log(actual / usual)|); coverage is the share of
// runs that finished under the slow figure. Labels are derived from each
// row's tool calls (names and folders), so a rule can be compared without
// rewriting the log. Nothing here reads or keeps text.

import path from 'node:path'
import { agentMsBefore, earlyByRun, summarizeRuns } from '../lib/aggregate.mjs'
import { EDIT_TOOLS, SHAPE_STEPS, SUBMIT_STEPS, classifyRun, parseList, shapeOf } from '../lib/classify.mjs'
import { modelKey } from '../lib/price.mjs'
import { LEVELS, replay, replayAgentsAtStep, replayAtStep, scoreSteps, typicalError, wilson, withAgents } from '../lib/stats.mjs'
import { loadAllRows } from './report.mjs'
import { isMainModule } from './main.mjs'

const NONE = '(none)'
/** The matching before shape: the same keys with every null compared as a value. */
const LEGACY_LEVELS = [
  { name: 'type+project+model', keys: ['taskType', 'project', 'model'] },
  { name: 'type+project', keys: ['taskType', 'project'] },
  { name: 'type+model', keys: ['taskType', 'model'] },
  { name: 'type', keys: ['taskType'] },
]

export function parseArgs(argv) {
  /** @type {any} */
  const o = { vault: process.cwd(), ignore: [], projectsFolder: '', steps: [3, 5, 8] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--vault') o.vault = path.resolve(argv[++i] ?? '')
    else if (a === '--ignore') o.ignore = parseList(argv[++i])
    else if (a === '--projects-folder') o.projectsFolder = String(argv[++i] ?? '')
    else if (a === '--steps') o.steps = String(argv[++i] ?? '').split(',').map(Number).filter(n => n > 0)
  }
  return o
}

/** A run's labels from the facts of its first `limit` requests (all of them by default). */
function labelOf(facts, command, setup, limit = Infinity) {
  const idx = facts.skillSteps.flatMap((step, i) => (step <= limit ? [i] : []))
  const calls = facts.calls.filter(c => c.step <= limit)
  return classifyRun({
    skills: idx.map(i => facts.skills[i]),
    skillWork: idx.map(i => facts.skillWork[i]),
    projectsFolder: setup.projectsFolder,
    command,
    ignore: setup.ignore,
    ...(setup.helpers ? { helpers: setup.helpers } : {}),
    editedPaths: calls.filter(c => EDIT_TOOLS.has(c.name) && c.dir).map(c => c.dir),
    readPaths: calls.filter(c => c.name === 'Read' && c.dir).map(c => c.dir),
  })
}

/** @param {any} setup { ignore, helpers?, legacy? } */
function replayRuns(usable, early, setup) {
  const legacy = setup.legacy === true
  const query = (/** @type {any} */ r, /** @type {any} */ q) => ({
    ...q,
    ...(legacy ? { project: q.project ?? NONE, model: q.model ?? NONE, shape: undefined } : {}),
  })
  const runs = usable.map(s => {
    const e = early.get(s.runId)
    const label = e ? labelOf(e.facts, e.command, setup) : { taskType: s.taskType, project: s.project }
    const run = {
      runId: s.runId,
      taskType: label.taskType,
      project: label.project,
      model: modelKey(s.model),
      effort: s.effort,
      promptChars: s.promptChars,
      shape: s.shape,
      agentMs: s.agentMs,
      usd: s.usd,
      endedAt: s.endedAt,
      startedAt: s.startedAt,
      agents: s.subagents.map(a => ({ type: a.agentType, startedAt: a.startedAt, endedAt: a.endedAt })),
      mainLastAt: s.mainLastAt,
    }
    return legacy ? { ...run, project: run.project ?? NONE, model: run.model ?? NONE, shape: undefined } : run
  })
  const levels = legacy ? LEGACY_LEVELS : LEVELS
  const byId = new Map(runs.map(r => [r.runId, r]))
  const commandOf = (/** @type {string} */ id) => {
    const c = early.get(id)?.command
    const bare = c ? c.replace(/^\//, '') : null
    return bare && !setup.ignore.includes(bare.toLowerCase()) ? bare : null
  }
  const out = {}
  out.final = replay(runs, { levels, labels: 'final' })
  out.submit = replay(runs, {
    levels,
    queryOf: r => query(r, { taskType: commandOf(r.runId) ?? 'freeform', project: null, model: r.model === NONE ? null : r.model, effort: r.effort, promptChars: r.promptChars }),
  })
  out.kept = replay(runs, {
    levels,
    queryOf: r => {
      const e = early.get(r.runId)
      const l = e ? labelOf(e.facts, e.command, setup, SUBMIT_STEPS) : { taskType: commandOf(r.runId) ?? 'freeform', project: null }
      return query(r, { taskType: l.taskType, project: l.project, model: r.model === NONE ? null : r.model, effort: r.effort, promptChars: r.promptChars })
    },
  })
  out.steps = {}
  out.agentSteps = {}
  for (const k of setup.steps) {
    const stateOf = (/** @type {any} */ r) => {
      const e = early.get(r.runId)
      const elapsedMs = e ? agentMsBefore(e.facts, k + 1) : null
      if (!e || elapsedMs === null) return null
      const l = labelOf(e.facts, e.command, setup, k)
      const shape = k >= SHAPE_STEPS ? shapeOf(e.facts.calls.filter(c => c.step <= SHAPE_STEPS).map(c => c.name)) : undefined
      const q = query(r, { taskType: l.taskType, project: l.project, model: r.model === NONE ? null : r.model, effort: r.effort, promptChars: r.promptChars, shape })
      return { elapsedMs, at: e.facts.stepStarts[k] ?? 0, query: q }
    }
    out.steps[k] = replayAtStep(runs, { levels, stateOf })
    out.agentSteps[k] = replayAgentsAtStep(runs, { stateOf })
  }
  return { out, byId }
}

/** Typical miss and coverage over replayed rows (a `submit` or `step` figure each). */
export function scoreRows(rows, field) {
  const ok = rows.filter(r => r[field])
  const miss = typicalError(ok.map(r => ({ usualMs: r[field].usualMs, actualMs: r.actualMs })))
  return { runs: rows.length, scored: ok.length, miss: miss === null ? null : Math.exp(miss), coverage: ok.length === 0 ? null : ok.filter(r => r.actualMs <= r[field].slowMs).length / ok.length }
}

const cell = m => (m.miss === null ? '-' : `x${m.miss.toFixed(2)} / ${(m.coverage * 100).toFixed(1)}% (${m.scored} of ${m.runs})`)

export function evaluate(rows, options) {
  const summaries = summarizeRuns(rows)
  const usable = summaries.filter(r => r.outcome === 'finished' && r.agentMs > 0)
  const early = earlyByRun(rows)
  const common = { ignore: options.ignore, steps: options.steps, projectsFolder: options.projectsFolder ?? '' }
  const setups = { legacy: { ...common, helpers: [], legacy: true }, matching: { ...common, helpers: [] }, current: { ...common } }
  const names = Object.keys(setups)
  const lines = [`state | set | ${names.map(n => `${n}: miss / slow coverage`).join(' | ')}`, `--- | --- | ${names.map(() => '---').join(' | ')}`]
  const results = Object.fromEntries(Object.entries(setups).map(([name, s]) => [name, replayRuns(usable, early, s)]))
  const pick = (name, state, k) => {
    const r = results[name]
    const rowsOf = k ? r.out.steps[k] : r.out[state]
    return { rows: rowsOf, field: k ? 'step' : 'submit' }
  }
  const states = [
    ['final', 'final labels (known only after the run)', null],
    ['submit', 'at submit, first estimate', null],
    ['kept', `at submit, as kept (labels of the first ${SUBMIT_STEPS} requests)`, null],
    ...options.steps.map(k => [`steps`, `after ${k} requests`, k]),
  ]
  for (const [state, title, k] of states) {
    for (const [set, test] of [['freeform', r => r.taskType === 'freeform'], ['all runs', () => true]]) {
      const cells = names.map(name => {
        const p = pick(name, state, k)
        return cell(scoreRows(p.rows.filter(test), p.field))
      })
      lines.push(`${title} | ${set} | ${cells.join(' | ')}`)
    }
  }
  const counts = name => {
    const c = new Map()
    for (const r of results[name].byId.values()) c.set(r.taskType, (c.get(r.taskType) ?? 0) + 1)
    return [...c].sort((a, b) => b[1] - a[1])
  }
  // by shape (the run's own, as the report has it), for the current setup
  const shapeOf_ = new Map(usable.map(r => [r.runId, r.shape ?? 'answer']))
  const keyOf = (/** @type {{ runId: string }} */ r) => shapeOf_.get(r.runId) ?? 'answer'
  const states_ = [['submit, first estimate', results.current.out.submit, 'submit'], ['submit, as kept', results.current.out.kept, 'submit'], ...options.steps.map(k => [`step ${k}`, results.current.out.steps[k], 'step'])]
  const byState = states_.map(([title, rowsOf, field]) => [title, scoreSteps(rowsOf, keyOf, field)])
  const shapes = ['answer', 'read', 'shell', 'edit', 'agents']
  const shapeCell = g => {
    if (!g || g.scored === 0) return '-'
    const ci = wilson(g.hits, g.scored)
    return `${(g.coverage * 100).toFixed(0)}% (${ci ? `${(ci.lo * 100).toFixed(0)} to ${(ci.hi * 100).toFixed(0)}` : '-'}) x${Math.exp(g.error ?? 0).toFixed(2)}, n=${g.scored}${g.scored < 30 ? ' too few to say' : ''}`
  }
  const shapeLines = [`shape | ${byState.map(([t]) => `${t}: slow coverage (95% interval) typical miss`).join(' | ')}`, `--- | ${byState.map(() => '---').join(' | ')}`]
  for (const shape of shapes) shapeLines.push(`${shape} | ${byState.map(([, g]) => shapeCell(g[shape])).join(' | ')}`)
  // the same step rows with the subagent-aware figure wherever agents were going
  const agentStates = options.steps.map(k => {
    const rows = withAgents(results.current.out.steps[k], results.current.out.agentSteps[k])
    const going = new Map()
    for (const r of rows) if (r.step && r.going) going.set(keyOf(r), (going.get(keyOf(r)) ?? 0) + 1)
    return [`step ${k}`, scoreSteps(rows, keyOf, 'step'), going]
  })
  const agentLines = [`shape | ${agentStates.map(([t]) => `${t}: slow coverage (95% interval) typical miss, rows with agents going`).join(' | ')}`, `--- | ${agentStates.map(() => '---').join(' | ')}`]
  for (const shape of shapes) agentLines.push(`${shape} | ${agentStates.map(([, g, going]) => (g[shape] && g[shape].scored > 0 ? `${shapeCell(g[shape])}, ${going.get(shape) ?? 0} going` : '-')).join(' | ')}`)
  const fellBack = summaries.reduce((s, r) => s + r.fellBack, 0)
  return { table: lines.join('\n'), shapeTable: shapeLines.join('\n'), agentTable: agentLines.join('\n'), labels: Object.fromEntries(names.map(n => [n, counts(n)])), fellBack }
}

if (isMainModule(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2))
  const { table, shapeTable, agentTable, labels, fellBack } = evaluate(loadAllRows(opts.vault), opts)
  console.log(`Run clock: ${fellBack} row${fellBack === 1 ? '' : 's'} could not be placed and added their stored time.\n`)
  console.log(table)
  console.log(`\nBy shape (current setup):\n${shapeTable}`)
  console.log(`\nBy shape, subagent-aware step figure where agents were going (current setup, same rows):\n${agentTable}`)
  for (const name of Object.keys(labels)) console.log(`\n${name} labels: ${labels[name].slice(0, 10).map(([t, n]) => `${t} ${n}`).join(', ')}`)
}
