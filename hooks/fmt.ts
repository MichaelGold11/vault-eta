// Short forms the band and the pane print. Times are agent time unless a
// caller says otherwise; dollars are at API prices.

/** Whole seconds as m:ss, or h:mm:ss from an hour. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** A rough duration: `40s`, `4m`, `1h 20m`. */
export function rough(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${Math.max(1, Math.round(s))}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`
}

/** Time left, never negative: `~40s`, `~4m`, `~1h 20m`. Under a minute it moves in tens of seconds. */
export function left(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 55) return `~${Math.max(10, Math.round(s / 10) * 10)}s`
  return `~${rough(ms)}`
}

/** An estimate's range: `3-5m`, `40-90s`, `40s-2m`, or one figure when both round alike. */
export function range(usualMs: number, slowMs: number): string {
  const a = rough(usualMs)
  const b = rough(Math.max(usualMs, slowMs))
  if (a === b) return a
  const unit = (t: string) => (/^\d+m$/.test(t) ? 'm' : /^\d+s$/.test(t) ? 's' : '')
  if (unit(a) !== '' && unit(a) === unit(b)) return `${a.slice(0, -1)}-${b}`
  return `${a}-${b}`
}

/** A run's cost: `$0.81`, `<$0.01`, `$123`. */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  if (usd >= 100) return `$${Math.round(usd)}`
  return `$${usd.toFixed(2)}`
}

/** A day's or a job's cost: whole dollars from $10 (`today $38`). */
export function moneyRound(usd: number): string {
  return usd >= 10 ? `$${Math.round(usd)}` : money(usd)
}

/**
 * A cost with what it leaves out: `--` when no part had a price (a model
 * missing from the price table), `$0.81+` when only some did.
 */
export function cost(c: { usd: number; priced: number; unpriced: number }, isRounded = false): string {
  if (c.unpriced > 0 && c.priced === 0) return '--'
  const text = isRounded ? moneyRound(c.usd) : money(c.usd)
  return c.unpriced > 0 ? `${text}+` : text
}

/** Token counts: `912`, `48.2k`, `1.3M`. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}
