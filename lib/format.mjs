// @ts-check
// Formatting shared by the band, the pane, the report and the backfill.
// Small formatters for durations, tokens and dollars.

/**
 * @param {number} n
 * @returns {string}
 */
export function fmtTok(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

/**
 * @param {number} n
 * @returns {string}
 */
export function fmtUsd(n) {
  if (n <= 0) return '$0'
  if (n < 1) return `$${n.toFixed(3)}`
  return n < 100 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`
}

/**
 * A cost with what it leaves out: `--` when no part had a price (a model
 * missing from the price table), `$1.20+` when only some did.
 * @param {number} usd the priced parts' sum
 * @param {number} priced parts with a price
 * @param {number} unpriced parts without one
 * @returns {string}
 */
export function fmtCost(usd, priced, unpriced) {
  if (unpriced > 0 && priced === 0) return '--'
  return unpriced > 0 ? `${fmtUsd(usd)}+` : fmtUsd(usd)
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function fmtSecs(ms) {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}m ${String(r).padStart(2, '0')}s`
}

/**
 * @param {number} usd
 * @returns {string}
 */
export function formatCost(usd) {
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`
}

/**
 * Whole seconds as m:ss.
 * @param {number} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * A duration for reading, from milliseconds: `42s`, `4m 12s`, `2h 05m`.
 * @param {number} ms
 * @returns {string}
 */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
