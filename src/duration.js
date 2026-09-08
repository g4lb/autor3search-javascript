/**
 * Duration parsing, used for `timeout` in the run configuration. Values are
 * written as a number and a unit ("1s", "500ms", "15m"), optionally
 * compounded ("1m30s") — the notation most performance tooling already uses,
 * so there is nothing new to learn here.
 */

/** Milliseconds per unit. */
const UNITS = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
}

/** One `<number><unit>` term, e.g. "1h", "30.5s". */
const TERM = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gy

/**
 * Parses a duration into milliseconds. Fractional values and compound terms
 * ("1m30s") are both accepted; a negative or unitless value is not.
 *
 * @param {string} s
 * @returns {number} milliseconds
 * @throws {Error} when s is not a duration
 */
export function parseDuration(s) {
  const bad = () => new Error(`${JSON.stringify(s)} is not a duration (want e.g. "500ms", "1s", "15m")`)
  if (typeof s !== 'string' || s.length === 0) throw bad()

  TERM.lastIndex = 0
  let total = 0
  let terms = 0
  let lastIndex = 0
  let match
  while ((match = TERM.exec(s)) !== null) {
    total += Number(match[1]) * UNITS[match[2]]
    terms++
    lastIndex = TERM.lastIndex
  }
  // The sticky flag anchors each term to the end of the previous one, so a
  // full match means lastIndex reached the end of the string. Anything left
  // over — a leading sign, a stray unit, trailing text — means this was not a
  // duration, and must not be silently accepted as its parseable prefix.
  if (terms === 0 || lastIndex !== s.length) throw bad()
  return total
}

/**
 * Renders milliseconds back into the same notation parseDuration accepts.
 * Used only for human-facing output.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${round(ms)}ms`
  const totalSeconds = ms / 1000
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = round(totalSeconds % 60)
  let out = ''
  if (hours) out += `${hours}h`
  if (minutes) out += `${minutes}m`
  if (seconds || out === '') out += `${seconds}s`
  return out
}

/** Rounds to at most three decimal places, dropping a trailing ".0". */
function round(n) {
  return Number(n.toFixed(3))
}
