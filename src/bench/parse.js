/**
 * Turns Vitest's benchmark JSON report into a BenchSet.
 *
 * The format belongs to Vitest, not to us, so this module validates what it
 * receives and fails LOUDLY on anything it does not recognise. A silently
 * changed reporter shape that yielded an empty set would surface downstream
 * as "no benchmarks matched the pattern" — which reads like a user
 * configuration error and is not one. See test/fixtures/README.md, which
 * records the real, captured shape (confirmed against Vitest 2.1.9):
 *
 *   { files: [ { filepath, groups: [ { fullName, benchmarks: [
 *       { name, median, mean, hz, samples, ... }, ...
 *   ] }, ... ] }, ... ] }
 *
 * That shape is captured with `vitest bench --run --outputJson=<file>` — NOT
 * the generic `--reporter=json --outputFile=<file>`, which fails because
 * `bench` has no built-in reporter registered under the name "json"; see
 * test/fixtures/README.md for the discrepancy.
 *
 * One parse contributes ONE observation per benchmark: the median Vitest
 * reports for that task. Tinybench computes it over the samples taken inside
 * a single process invocation, which is exactly the per-round statistic the
 * scoring core needs — see the spec's section 3.2 for why the individual
 * samples must never reach the significance test. (In practice the captured
 * `samples` array is empty — Tinybench does not retain raw samples in this
 * report — so the fallback below rarely if ever fires against real Vitest
 * output; it exists as a defensive path for another shape variant.)
 */
import { BenchSet, UNIT_TIME } from './set.js'

/**
 * Vitest reports task timings (min/max/mean/median/period/pNN) in
 * milliseconds; the scoring core uses seconds.
 */
const MS_TO_SEC = 1e-3

/**
 * @param {object|string} payload the reporter's JSON, parsed or raw
 * @returns {BenchSet}
 */
export function parseVitestBench(payload) {
  const report = typeof payload === 'string' ? parseJson(payload) : payload

  const files = report?.files
  if (!Array.isArray(files)) {
    throw new Error(
      `unrecognised Vitest benchmark report: expected an object with a "files" array, got ` +
        `${excerpt(report)}. Re-capture test/fixtures/vitest-bench.json and update src/bench/parse.js.`,
    )
  }

  const set = new BenchSet()
  let found = 0
  for (const file of files) {
    for (const group of file?.groups ?? []) {
      for (const task of group?.benchmarks ?? []) {
        const name = task?.name
        if (typeof name !== 'string') {
          throw new Error(`unrecognised Vitest benchmark entry, missing a string name: ${excerpt(task)}`)
        }
        const ms = timingMs(task)
        if (ms === null) {
          throw new Error(
            `benchmark ${JSON.stringify(name)} has no timing the harness can read (looked for ` +
              `"median", then "mean", then "samples"): ${excerpt(task)}`,
          )
        }
        set.record(taskPath(file, group, name), name, UNIT_TIME, ms * MS_TO_SEC)
        found++
      }
    }
  }

  if (found === 0) {
    throw new Error(
      'the Vitest benchmark report contained no benchmarks — check that the bench files declare ' +
        'bench() tasks and that the name filter is not excluding all of them',
    )
  }
  return set
}

/**
 * The task's timing in milliseconds. Prefers the reported median, because it
 * is the robust centre tinybench already computed; falls back to the mean,
 * then to a median taken over raw samples.
 */
function timingMs(task) {
  if (Number.isFinite(task?.median)) return task.median
  if (Number.isFinite(task?.mean)) return task.mean
  if (Array.isArray(task?.samples) && task.samples.length > 0) {
    const sorted = [...task.samples].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }
  return null
}

/**
 * The full task path, matching how Vitest names a benchmark: the group's
 * fullName (which already includes the file and any enclosing describes),
 * then the leaf name.
 */
function taskPath(file, group, name) {
  const prefix = group?.fullName ?? file?.filepath ?? ''
  return prefix === '' ? name : `${prefix} > ${name}`
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`parse Vitest benchmark report: ${err.message}: ${excerpt(text)}`, { cause: err })
  }
}

/** A short, safe excerpt of an unexpected payload, for the error message. */
function excerpt(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? String(value)).slice(0, 300)
}
