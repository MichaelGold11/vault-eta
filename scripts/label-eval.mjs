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
// estimate really has:
//
//   final   the run's own labels known (the report's accuracy table)
//   submit  only what the first estimate has: the slash command, prompt size,
//           model and effort (no skill, no folder, no shape yet)
//   steps k after k model requests: the skills loaded so far, the folders
//           touched so far and, from the third request, the shape; the matches
//           still going give the time left (history part of the estimate only)
//
// Typical miss is exp(median |log(actual / usual)|); coverage is the share of
// runs that finished under the slow figure. Labels are derived from each
// row's tool calls (names and folders), so a rule can be compared without
// rewriting the log. Nothing here reads or keeps text.

import path from 'node:path'
import { agentMsBefore, earlyByRun, summarizeRuns } from '../lib/aggregate.mjs'
import { EDIT_TOOLS, SHAPE_STEPS, classifyRun, parseList, shapeOf } from '../lib/classify.mjs'
import { modelKey } from '../lib/price.mjs'
import { LEVELS, replay, replayAtStep, typicalError } from '../lib/stats.mjs'
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
  out.final = replay(runs, { levels })
  out.submit = replay(runs, {
    levels,
    queryOf: r => query(r, { taskType: commandOf(r.runId) ?? 'freeform', project: null, model: r.model === NONE ? null : r.model, effort: r.effort, promptChars: r.promptChars }),
  })
  out.steps = {}
  for (const k of setup.steps) {
    out.steps[k] = replayAtStep(runs, {
      levels,
      stateOf: r => {
        const e = early.get(r.runId)
        const elapsedMs = e ? agentMsBefore(e.facts, k + 1) : null
        if (!e || elapsedMs === null) return null
        const l = labelOf(e.facts, e.command, setup, k)
        const shape = k >= SHAPE_STEPS ? shapeOf(e.facts.calls.filter(c => c.step <= SHAPE_STEPS).map(c => c.name)) : undefined
        const q = query(r, { taskType: l.taskType, project: l.project, model: r.model === NONE ? null : r.model, effort: r.effort, promptChars: r.promptChars, shape })
        return { elapsedMs, query: q }
      },
    })
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
  const states = [['final', 'final labels', null], ['submit', 'at submit', null], ...options.steps.map(k => [`steps`, `after ${k} requests`, k])]
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
  return { table: lines.join('\n'), labels: Object.fromEntries(names.map(n => [n, counts(n)])) }
}

if (isMainModule(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2))
  const { table, labels } = evaluate(loadAllRows(opts.vault), opts)
  console.log(table)
  for (const name of Object.keys(labels)) console.log(`\n${name} labels: ${labels[name].slice(0, 10).map(([t, n]) => `${t} ${n}`).join(', ')}`)
}
