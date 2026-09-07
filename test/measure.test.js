import { describe, expect, it } from 'vitest'
import { BenchSet, UNIT_TIME } from '../src/bench/set.js'
import { interleave, measure } from '../src/measure.js'
import { makeBenchRepo } from './helpers/bench-repo.js'

/** A side that records the order in which it was called. */
function side(label, order, value = 1) {
  return async (round) => {
    order.push(`${label}${round}`)
    const set = new BenchSet()
    set.record('b', 'b', UNIT_TIME, value)
    return set
  }
}

describe('interleave', () => {
  it('collects one observation per side per measured round', async () => {
    const order = []
    const { baseSet, candSet } = await interleave({
      rounds: 4,
      warmup: false,
      base: side('B', order),
      cand: side('C', order),
    })
    expect(baseSet.values('b', UNIT_TIME)).toHaveLength(4)
    expect(candSet.values('b', UNIT_TIME)).toHaveLength(4)
  })

  it('swaps the within-round order on alternate rounds', async () => {
    const order = []
    await interleave({ rounds: 4, warmup: false, base: side('B', order), cand: side('C', order) })
    expect(order).toEqual(['B0', 'C0', 'C1', 'B1', 'B2', 'C2', 'C3', 'B3'])
  })

  it('gives each side the first slot equally often at an even round count', async () => {
    const order = []
    await interleave({ rounds: 10, warmup: false, base: side('B', order), cand: side('C', order) })
    const firsts = order.filter((_, i) => i % 2 === 0)
    expect(firsts.filter((s) => s.startsWith('B'))).toHaveLength(5)
    expect(firsts.filter((s) => s.startsWith('C'))).toHaveLength(5)
  })

  it('runs and discards a leading warmup round', async () => {
    const order = []
    const { baseSet } = await interleave({
      rounds: 3,
      warmup: true,
      base: side('B', order),
      cand: side('C', order),
    })
    expect(order).toHaveLength(8) // 4 rounds run
    expect(baseSet.values('b', UNIT_TIME)).toHaveLength(3) // 3 kept
  })

  it('refuses fewer than two measured rounds', async () => {
    await expect(
      interleave({ rounds: 1, warmup: false, base: side('B', []), cand: side('C', []) }),
    ).rejects.toThrow(/at least 2 measured rounds/)
  })

  it('names the side and round when one fails', async () => {
    const failing = async () => {
      throw new Error('boom')
    }
    await expect(
      interleave({ rounds: 2, warmup: false, base: side('B', []), cand: failing }),
    ).rejects.toThrow(/candidate round 0/)
  })

  it('stops when the abort signal fires', async () => {
    const controller = new AbortController()
    const order = []
    const slow = (label) => async (round) => {
      order.push(`${label}${round}`)
      if (order.length === 2) controller.abort()
      const set = new BenchSet()
      set.record('b', 'b', UNIT_TIME, 1)
      return set
    }
    await expect(
      interleave({ rounds: 6, warmup: false, base: slow('B'), cand: slow('C'), signal: controller.signal }),
    ).rejects.toThrow(/aborted/i)
    expect(order.length).toBeLessThan(12)
  })
})

describe('measure', () => {
  it('measures two real worktrees and returns both sides', async () => {
    const dir = await makeBenchRepo()
    const { baseSet, candSet } = await measure({
      runner: 'vitest',
      baseDir: dir,
      candDir: dir,
      benchmarks: [],
      rounds: 2,
      warmup: false,
      timeoutMs: 120_000,
      heapHint: false,
    })
    expect(baseSet.values(baseSet.names()[0], UNIT_TIME)).toHaveLength(2)
    expect(candSet.values(candSet.names()[0], UNIT_TIME)).toHaveLength(2)
  })

  it('adds bytes/op observations when the heap hint is enabled', async () => {
    const dir = await makeBenchRepo()
    const { baseSet } = await measure({
      runner: 'vitest',
      baseDir: dir,
      candDir: dir,
      benchmarks: [],
      rounds: 2,
      warmup: false,
      timeoutMs: 120_000,
      heapHint: true,
      benchFiles: ['src/wordcount.bench.js'],
      heapIterations: 100,
    })
    const { UNIT_BYTES } = await import('../src/bench/set.js')
    expect(baseSet.names().some((n) => baseSet.has(n, UNIT_BYTES))).toBe(true)
  })

  // The bench adapter's contract (src/adapters/bench/index.js, verified against
  // src/adapters/bench/vitest.js) takes a `benchmarks` array — there is no
  // regexp `pattern` field, and Vitest's own name filter does not even work on
  // benches. `measure` mirrors that: it requires `benchmarks` to be an array
  // (an EMPTY one is the valid, common "measure everything" case — see
  // src/adapters/bench/vitest.js's `opts.benchmarks ?? []` and config.js's
  // default `benchmarks: []`), so what it refuses is the field being absent or
  // the wrong shape, not the array being empty.
  it('refuses a non-array benchmarks list', async () => {
    await expect(measure({ runner: 'vitest', baseDir: '.', candDir: '.' })).rejects.toThrow(
      /benchmarks must be an array/,
    )
  })
})
