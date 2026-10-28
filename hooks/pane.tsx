import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { EtaView } from '../types'
import { LOOK, lineWidth, paneLines } from './layout'
import type { Part } from './layout'

// The side pane: `$.ui.open`, toggled by /eta at any width, opening by itself
// as a sidebar when a run starts on a wide fullscreen terminal (the person
// closing it stops that for the session). It draws the same view the band
// does, redrawn once a second while a run works, in this layout:
// header, progress, time left, confidence, NOW, WHO, the time
// split, speed, context, cost.

type Engine = EngineInterface

export const PANE = 'vault-eta'
export const TITLE = 'ETA'
/** The dock's width the pane asks for: 45 columns of content inside its border. */
export const PANE_COLUMNS = 48
/** The rows it asks for when seated inline above the prompt. */
export const PANE_ROWS = 18
/** Below this width an unasked pane would crowd the transcript: it is not opened by itself. */
export const AUTO_OPEN_COLUMNS = 144

const viewAtom = atom({ plugin: 'vault-eta', key: 'view' } as const, { kind: 'none' } as EtaView)
const dismissedAtom = atom({ plugin: 'vault-eta', key: 'isPaneDismissed' } as const, false)

/** The person asked for the pane (/eta, or an open of theirs): seated at any width. */
async function openPane($: Engine) {
  await update($, dismissedAtom, () => false)
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS })
}

/**
 * A run started: open the pane by itself where it lands as a sidebar, a
 * fullscreen terminal at least AUTO_OPEN_COLUMNS wide, unless the person
 * closed it this session or it is open already.
 */
export async function autoOpen($: Engine, viewport: { columns: number; isFullscreen: boolean | undefined } | null) {
  if (!viewport || viewport.isFullscreen !== true || viewport.columns < AUTO_OPEN_COLUMNS) return
  if (await read($, dismissedAtom)) return
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE)) return
  await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS })
}

export async function registerCommand($: Engine) {
  await $.command.register({
    name: 'eta',
    description: 'vault-eta: the ETA pane (open or close it), the history report (report), and job tags that add up a build across sessions (job <name>, job end)',
    argumentHint: '[open|close|report|job <name>|job end]',
    immediate: true,
  })
}

export function registerPane(on: On) {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(20, e.props.bodyColumns)
    const lines = paneLines(await read($, viewAtom), columns)
    const draw = (part: Part) => (
      <Text {...LOOK[part.look]} {...(part.bold ? { bold: true } : {})} wrap="truncate">
        {part.text}
      </Text>
    )
    return (
      <Box flexDirection="column">
        {lines.map(line => (line.length === 0 || lineWidth(line) === 0 ? <Text> </Text> : <Box flexDirection="row">{line.map(draw)}</Box>))}
      </Box>
    )
  })

  // Closed by the person (its mark, a key) or by /eta: it stops opening by itself this session.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE && e.origin.kind !== 'unload') await update($, dismissedAtom, () => true).catch(() => undefined)
    return result
  })
}

/**
 * /eta, /eta open, /eta close (routed here by register.tsx). Prints nothing,
 * so nothing it shows reaches the model; a word it does not know says what
 * the command takes in a toast.
 */
export async function paneCommand($: Engine, verb: string) {
  if (verb !== '' && verb !== 'open' && verb !== 'close') {
    $.ui.toast('/eta: open, close, report, scorecard, backfill, job <name>, job end.', { timeoutMs: 6000 })
    return
  }
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  // A pane opened by itself may wait for room: /eta seats it rather than closing it.
  const isSeated = pane !== undefined && pane.isPlaced
  if (verb === 'close' || (verb === '' && isSeated)) {
    if (pane) await $.ui.close({ id: PANE })
    await update($, dismissedAtom, () => true)
    return
  }
  await openPane($)
}
