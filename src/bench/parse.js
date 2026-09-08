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
 * samples must never reach the significance test. There is deliberately no
 * fallback to `mean` or to a median computed over `samples` if `median` is
 * absent — see `timingMs` below for why.
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
            `benchmark ${JSON.stringify(name)} reported no "median", which is the only timing this ` +
              `parser accepts: ${excerpt(task)}`,
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
 * The task's timing in milliseconds: tinybench's own reported median.
 *
 * Deliberately no fallback. A median-over-`samples` fallback was tried and
 * removed: Vitest 2.1.9's --outputJson writer hardcodes `samples: []`
 * regardless of `benchmark.includeSamples`, so that branch was provably dead
 * code. A mean fallback was removed for a different reason — the mean is a
 * DIFFERENT estimator, outlier-sensitive in exactly the way benchmark timings
 * punish, so silently substituting it would change what the score means
 * without saying so. If a future Vitest stops reporting a median, this throws
 * and names the benchmark, which is the honest failure.
 */
function timingMs(task) {
  return Number.isFinite(task?.median) ? task.median : null
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
