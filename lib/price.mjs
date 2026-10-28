// @ts-check
// What a model request costs "at API prices": the same tokens priced at the
// Anthropic first-party API's list rates, not money billed on a subscription.
//
// Plain ES module with no imports, shared by the hooks module and the
// standalone Node backfill script (scripts/backfill.mjs).
//
// Source: the claude-api skill bundled with Claude Code 2.1.302 (its model
// table, cached 2026-10-06; shared/models.md, shared/prompt-caching.md and
// shared/model-migration.md), checked 2026-10-18; cache reads checked again
// on 2026-10-28 against the pricing page (platform.claude.com/docs/en/about-claude/pricing)
// and Claude Code's own price catalog (2.1.307 to 2.1.312), which /cost uses.
// Claude Sonnet 5.5 reads cache at $0.10 there (0.05x input); the skill's
// table still says $0.20. USD per million tokens.
// Cache writes are 1.25x the input rate at the 5-minute TTL and 2x at the
// 1-hour TTL; cache reads differ by model and are listed as published.
// Claude Haiku 5.5 has two rate cards, split at a 100K-token prompt.
// Not covered: Bedrock and Vertex bill their own rates, and fast mode
// (Claude Opus 5.5 at $8 / $40) does not show in the usage the engine reports.
// A model not listed here is unpriced: usd null, never a guess.

export const PRICES_CHECKED = '2026-10-28'

/** @typedef {{ input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number }} Rate */
/** @typedef {Rate & { ids: string[], long?: Rate & { above: number } }} PriceRow */

/** @type {readonly PriceRow[]} */
export const PRICES = [
  { ids: ['claude-fable-5-1', 'claude-mythos-5-1'], input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  { ids: ['claude-fable-5', 'claude-mythos-5'], input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  { ids: ['claude-opus-5-5'], input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  { ids: ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'], input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  { ids: ['claude-sonnet-5-5'], input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  { ids: ['claude-sonnet-5'], input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  { ids: ['claude-sonnet-4-6'], input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  {
    ids: ['claude-haiku-5-5'],
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2,
    long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
  },
  { ids: ['claude-haiku-4-5'], input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
]

/**
 * The bare model id the table is keyed by: `us.anthropic.claude-opus-5-5`,
 * `claude-opus-5-5[1m]`, `claude-haiku-4-5-20251001` and `claude-opus-4-6@20260101`
 * all come to their plain id.
 * @param {unknown} model
 * @returns {string}
 */
export function normalizeModel(model) {
  let s = String(model ?? '').trim().toLowerCase()
  s = s.replace(/\[[^\]]*\]$/, '')
  const at = s.indexOf('claude-')
  if (at > 0) s = s.slice(at)
  s = s.replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '')
  return s
}

/**
 * The bare model id runs are matched on; null when none is known.
 * @param {unknown} model
 * @returns {string | null}
 */
export function modelKey(model) {
  const id = normalizeModel(model)
  return id === '' || id === 'unknown' ? null : id
}

/**
 * @param {unknown} model
 * @returns {PriceRow | undefined}
 */
export function priceOf(model) {
  const id = normalizeModel(model)
  return PRICES.find(p => p.ids.includes(id))
}

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite5m?: number, cacheWrite1h?: number }} Tokens
 */

/**
 * The four token counts from any usage shape: the engine's (ModelUsage, the
 * API's names), a transcript's (with `cache_creation`'s 5m and 1h split), or
 * this mod's own row (`input`, `output`, `cacheRead`, `cacheWrite`).
 * @param {any} u
 * @returns {Tokens}
 */
export function tokensOf(u) {
  if (!u || typeof u !== 'object') return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  if ('input_tokens' in u || 'output_tokens' in u || 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
    /** @type {Tokens} */
    const t = {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
    }
    const split = u.cache_creation
    if (split && typeof split === 'object') {
      t.cacheWrite5m = n(split.ephemeral_5m_input_tokens)
      t.cacheWrite1h = n(split.ephemeral_1h_input_tokens)
    }
    return t
  }
  /** @type {Tokens} */
  const t = { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite) }
  if (u.cacheWrite5m !== undefined || u.cacheWrite1h !== undefined) {
    t.cacheWrite5m = n(u.cacheWrite5m)
    t.cacheWrite1h = n(u.cacheWrite1h)
  }
  return t
}

/**
 * What one request (or a sum of requests on one model) costs at API prices.
 *
 * Cache writes use their real 5m/1h split when the usage carries one (the
 * transcripts do); otherwise all of them are priced at `cacheWriteTtl`, since
 * the engine's live usage has no split.
 *
 * @param {unknown} model
 * @param {any} usage
 * @param {{ cacheWriteTtl?: '1h' | '5m' }} [options]
 * @returns {{ usd: number | null, unpriced: boolean }}
 */
export function costOf(model, usage, options = {}) {
  const row = priceOf(model)
  if (!row) return { usd: null, unpriced: true }
  const t = tokensOf(usage)
  const prompt = t.input + t.cacheRead + t.cacheWrite
  /** @type {Rate} */
  const r = row.long && prompt > row.long.above ? row.long : row
  const hasSplit = t.cacheWrite5m !== undefined || t.cacheWrite1h !== undefined
  const w5 = hasSplit ? (t.cacheWrite5m ?? 0) : options.cacheWriteTtl === '5m' ? t.cacheWrite : 0
  const w1 = hasSplit ? (t.cacheWrite1h ?? 0) : options.cacheWriteTtl === '5m' ? 0 : t.cacheWrite
  // A split that does not add up (an older transcript): the rest goes at the TTL setting.
  const rest = hasSplit ? Math.max(0, t.cacheWrite - w5 - w1) : 0
  const restRate = options.cacheWriteTtl === '5m' ? r.cacheWrite5m : r.cacheWrite1h
  const usd =
    (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + w5 * r.cacheWrite5m + w1 * r.cacheWrite1h + rest * restRate) /
    1_000_000
  return { usd, unpriced: false }
}

/**
 * @param {unknown} model
 * @returns {'fable' | 'opus' | 'sonnet' | 'haiku' | 'other'}
 */
export function familyOf(model) {
  const m = String(model ?? '').toLowerCase()
  if (/fable|mythos/.test(m)) return 'fable'
  if (/opus/.test(m)) return 'opus'
  if (/sonnet/.test(m)) return 'sonnet'
  if (/haiku/.test(m)) return 'haiku'
  return 'other'
}
