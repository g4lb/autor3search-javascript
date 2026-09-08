/**
 * Collects observations from a baseline and a candidate tree in INTERLEAVED
 * order.
 *
 * This is the core measurement discipline. Comparing a candidate measured now
 * against a baseline measured minutes ago attributes CPU thermal drift,
 * frequency scaling and background load to the code change. Alternating the
 * two sides within a single session cancels that, because both sides
 * experience the same conditions.
 */
import { BenchSet } from './bench/set.js'
import { getBenchRunner } from './adapters/bench/index.js'
import { measureHeap } from './adapters/driver.js'

/**
 * Runs base and cand alternately for `rounds` measured rounds, accumulating
 * their observations. With `warmup`, one extra leading round is run and
 * discarded, absorbing first-touch effects such as cold caches and JIT
 * tier-up.
 *
 * The two sides SWAP ORDER on every round — base,cand then cand,base — rather
 * than always running base first. Alternating rounds alone cancels drift
 * BETWEEN rounds, but a fixed order within each round leaves a systematic
 * offset: the candidate would then always be measured one slot later than the
 * baseline, so any drift monotonic across a round (a CPU still ramping toward
 * its thermal steady state, a background job starting mid-run) lands on the
 * candidate in the same direction every single time. Averaging over rounds
 * does not remove it, because it is not noise — it is a constant bias, and it
 * shifts the score the KEEP threshold is compared against.
 *
 * An odd number of measured rounds cannot be split evenly and leaves one
 * round's worth of that offset behind; an even count cancels it exactly.
 *
 * @param {{rounds: number, warmup: boolean, base: (round: number) => Promise<BenchSet>, cand: (round: number) => Promise<BenchSet>, signal?: AbortSignal}} opts
 * @returns {Promise<{baseSet: BenchSet, candSet: BenchSet}>}
 */
export async function interleave({ rounds, warmup, base, cand, signal }) {
  if (rounds < 2) throw new Error(`need at least 2 measured rounds, got ${rounds}`)

  const baseSet = new BenchSet()
  const candSet = new BenchSet()
  const total = warmup ? rounds + 1 : rounds

  for (let i = 0; i < total; i++) {
    signal?.throwIfAborted()
    const baseFirst = i % 2 === 0
    const [first, second] = baseFirst ? [base, cand] : [cand, base]
    const [firstLabel, secondLabel] = baseFirst ? ['baseline', 'candidate'] : ['candidate', 'baseline']

    const firstSet = await labelled(first, i, firstLabel)
    signal?.throwIfAborted()
    const secondSet = await labelled(second, i, secondLabel)

    if (warmup && i === 0) continue
    baseSet.add(baseFirst ? firstSet : secondSet)
    candSet.add(baseFirst ? secondSet : firstSet)
  }
  return { baseSet, candSet }
}

/** Runs one side's round, naming which side and which round on failure. */
async function labelled(fn, round, label) {
  try {
    return await fn(round)
  } catch (err) {
    throw new Error(`${label} round ${round}: ${err.message}`, { cause: err })
  }
}

/**
 * Measures two worktrees for real, wiring the configured bench runner and,
 * when enabled, the heap-delta hint.
 *
 * The hint is folded into the SAME round as the timing so it gets the same
 * number of observations and therefore a real p-value. It is still never
 * scored — see src/pipeline.js.
 *
 * `benchmarks` selects by exact name, same as the bench adapter itself
 * (src/adapters/bench/vitest.js): an empty array is the valid, ordinary
 * "measure everything discovered" case, not an error. There is no regexp
 * `pattern` here — Vitest's own benchmark name filter does not work, so
 * selection happens after parsing, by exact name.
 *
 * @param {object} opts
 * @returns {Promise<{baseSet: BenchSet, candSet: BenchSet}>}
 */
export async function measure(opts) {
  if (!Array.isArray(opts.benchmarks)) {
    throw new Error('measure: benchmarks must be an array (empty selects every discovered benchmark)')
  }
  const runner = getBenchRunner(opts.runner)

  const roundFn = (dir) => async () => {
    const set = await runner.run(dir, {
      benchmarks: opts.benchmarks,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      log: opts.log,
      signal: opts.signal,
    })
    if (opts.heapHint) {
      set.add(
        await measureHeap(dir, {
          benchFiles: opts.benchFiles ?? [],
          benchmarks: opts.benchmarks,
          iterations: opts.heapIterations ?? 1000,
          timeoutMs: opts.timeoutMs,
          env: opts.env,
          log: opts.log,
          signal: opts.signal,
        }),
      )
    }
    return set
  }

  return interleave({
    rounds: opts.rounds,
    warmup: opts.warmup ?? true,
    base: roundFn(opts.baseDir),
    cand: roundFn(opts.candDir),
    signal: opts.signal,
  })
}
