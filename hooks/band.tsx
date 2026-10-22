import { atom, read } from 'claude-code'
import type { On, RenderElement } from 'claude-code'

import type { EtaView } from '../types'
import { LOOK, SEP, bandSegments, fitBand } from './layout'
import type { Part } from './layout'

// The band: one row above the prompt, below any other band (its segments
// are in layout.ts). It always calls next(e) and draws what the plugins
// beneath drew above its own row, so no other mod's band is hidden and the
// row sits under the strip whichever of the two runs first.

const viewAtom = atom({ plugin: 'vault-eta', key: 'view' } as const, { kind: 'none' } as EtaView)

/** What the plugins beneath drew, or undefined when they drew nothing (an empty Box). */
function drawnBelow(tree: RenderElement | null | undefined): RenderElement | undefined {
  if (tree === null || tree === undefined || typeof tree !== 'object') return undefined
  const el = tree as { type?: unknown; props?: { children?: unknown }; children?: unknown }
  const kids = el.children ?? el.props?.children
  const isEmpty = el.type === 'Box' && (kids === undefined || kids === null || (Array.isArray(kids) && kids.length === 0))
  return isEmpty ? undefined : tree
}

export type BandDeps = {
  /** The terminal's width and layout, as the band last measured them (the pane's auto-open reads them). */
  onViewport: (columns: number, isFullscreen: boolean | undefined) => void
}

export function registerBand(on: On, deps: BandDeps) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const result = await next(e)
    if (e.viewport) deps.onViewport(e.viewport.columns, e.viewport.isFullscreen)
    if (e.props.hasSurvey) return result
    const fitted = fitBand(bandSegments(await read($, viewAtom)), Math.max(4, e.props.bodyColumns))
    if (fitted.length === 0) return result
    const { Box, Text } = $.ui.resolve(e)
    const draw = (part: Part) => (
      <Text {...LOOK[part.look]} {...(part.bold ? { bold: true } : {})} wrap="truncate">
        {part.text}
      </Text>
    )
    const children = fitted.flatMap((segment, i) => [...(i === 0 ? [] : [<Text dimColor wrap="truncate">{SEP}</Text>]), ...segment.parts.map(draw)])
    const row = <Box flexDirection="row">{children}</Box>
    const below = drawnBelow(result)
    return below === undefined ? row : <Box flexDirection="column">{below}{row}</Box>
  })
}
