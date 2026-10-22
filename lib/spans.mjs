// @ts-check
// Time spans as [start, end] pairs in milliseconds, and the few set
// operations the time split needs: parallel tool calls, waits that overlap a
// sleep, and a turn's window.

/** @typedef {[number, number]} Span */

/**
 * Sorted, merged and with empty spans dropped.
 * @param {readonly Span[]} spans
 * @returns {Span[]}
 */
export function union(spans) {
  const sorted = spans
    .filter(s => Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0])
    .map(s => /** @type {Span} */ ([s[0], s[1]]))
    .sort((a, b) => a[0] - b[0])
  /** @type {Span[]} */
  const out = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else out.push(s)
  }
  return out
}

/**
 * Total length of the spans, overlaps counted once.
 * @param {readonly Span[]} spans
 * @returns {number}
 */
export function lengthOf(spans) {
  return union(spans).reduce((sum, s) => sum + (s[1] - s[0]), 0)
}

/**
 * The parts of the spans inside the window.
 * @param {readonly Span[]} spans
 * @param {Span} window
 * @returns {Span[]}
 */
export function clip(spans, window) {
  return union(spans)
    .map(s => /** @type {Span} */ ([Math.max(s[0], window[0]), Math.min(s[1], window[1])]))
    .filter(s => s[1] > s[0])
}

/**
 * The parts of `spans` not covered by `minus`.
 * @param {readonly Span[]} spans
 * @param {readonly Span[]} minus
 * @returns {Span[]}
 */
export function subtract(spans, minus) {
  const cut = union(minus)
  /** @type {Span[]} */
  const out = []
  for (const s of union(spans)) {
    let start = s[0]
    for (const m of cut) {
      if (m[1] <= start || m[0] >= s[1]) continue
      if (m[0] > start) out.push([start, m[0]])
      start = Math.max(start, m[1])
      if (start >= s[1]) break
    }
    if (start < s[1]) out.push([start, s[1]])
  }
  return out
}

/**
 * How much of `spans` falls inside the window, overlaps counted once.
 * @param {readonly Span[]} spans
 * @param {Span} window
 * @returns {number}
 */
export function overlapMs(spans, window) {
  return lengthOf(clip(spans, window))
}
