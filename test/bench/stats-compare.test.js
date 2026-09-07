import { describe, expect, it } from 'vitest'
import { BenchSet, UNIT_TIME } from '../../src/bench/set.js'
import { compare, compareAll, geoMean } from '../../src/bench/stats.js'

function setOf(entries) {
  const s = new BenchSet()
  for (const [name, base, values] of entries) {
    for (const v of values) s.record(name, base, UNIT_TIME, v)
  }
  return s
}

const slow = (n = 10) => Array.from({ length: n }, (_, i) => 100 + i)
const fast = (n = 10) => Array.from({ length: n }, (_, i) => 50 + i)

describe('compare', () => {
  it('reports the ratio of candidate to baseline medians', () => {
    const d = compare(setOf([['p', 'p', slow()]]), setOf([['p', 'p', fast()]]), 'p', UNIT_TIME)
    expect(d.baseCenter).toBe(104.5)
    expect(d.candCenter).toBe(54.5)
    expect(d.ratio).toBeCloseTo(54.5 / 104.5, 10)
  })

  it('reports the percentage change alongside the ratio', () => {
    const d = compare(setOf([['p', 'p', slow()]]), setOf([['p', 'p', fast()]]), 'p', UNIT_TIME)
    expect(d.pctChange).toBeCloseTo((54.5 / 104.5 - 1) * 100, 8)
    expect(d.pctChange).toBeLessThan(0)
  })

  it('marks a clean separation as significant at the raw alpha', () => {
    const d = compare(setOf([['p', 'p', slow()]]), setOf([['p', 'p', fast()]]), 'p', UNIT_TIME)
    expect(d.significant).toBe(true)
    expect(d.alpha).toBe(0.05)
    expect(d.p).toBeLessThan(0.05)
  })

  it('does not mark overlapping samples as significant', () => {
    const a = setOf([['p', 'p', [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]]])
    const b = setOf([['p', 'p', [10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5]]])
    expect(compare(a, b, 'p', UNIT_TIME).significant).toBe(false)
  })

  it('carries the sample sizes', () => {
    const d = compare(setOf([['p', 'p', slow(8)]]), setOf([['p', 'p', fast(6)]]), 'p', UNIT_TIME)
    expect(d.nBase).toBe(8)
    expect(d.nCand).toBe(6)
  })

  it('deduplicates warnings raised by both summaries', () => {
    const d = compare(setOf([['p', 'p', [1, 2, 3, 4]]]), setOf([['p', 'p', [5, 6, 7, 8]]]), 'p', UNIT_TIME)
    expect(new Set(d.warnings).size).toBe(d.warnings.length)
    expect(d.warnings.join(' ')).toMatch(/at least 6/)
  })

  it('errors when the baseline lacks the unit', () => {
    expect(() => compare(new BenchSet(), setOf([['p', 'p', fast()]]), 'p', UNIT_TIME))
      .toThrow(/baseline has no/)
  })

  it('errors when the candidate lacks the unit', () => {
    expect(() => compare(setOf([['p', 'p', slow()]]), new BenchSet(), 'p', UNIT_TIME))
      .toThrow(/candidate has no/)
  })

  it('errors rather than forming a ratio against a zero baseline', () => {
    const zero = setOf([['p', 'p', [0, 0, 0, 0, 0, 0]]])
    expect(() => compare(zero, setOf([['p', 'p', fast(6)]]), 'p', UNIT_TIME)).toThrow(/median is zero/)
  })

  it('errors when a side has fewer than two observations', () => {
    expect(() => compare(setOf([['p', 'p', [1]]]), setOf([['p', 'p', [2]]]), 'p', UNIT_TIME))
      .toThrow(/at least 2 observations/)
  })
})

describe('compareAll', () => {
  it('compares every benchmark present in both sets, sorted by name', () => {
    const base = setOf([['b', 'b', slow()], ['a', 'a', slow()]])
    const cand = setOf([['b', 'b', fast()], ['a', 'a', fast()]])
    expect(compareAll(base, cand, UNIT_TIME).map((d) => d.name)).toEqual(['a', 'b'])
  })

  it('errors when a benchmark measured at baseline vanished from the candidate', () => {
    const base = setOf([['a', 'a', slow()], ['b', 'b', slow()]])
    const cand = setOf([['a', 'a', fast()]])
    expect(() => compareAll(base, cand, UNIT_TIME)).toThrow(/missing from the candidate/)
    expect(() => compareAll(base, cand, UNIT_TIME)).toThrow(/cannot be checked for regressions/)
  })

  it('ignores a benchmark the candidate added that the baseline never had', () => {
    const base = setOf([['a', 'a', slow()]])
    const cand = setOf([['a', 'a', fast()], ['new', 'new', fast()]])
    expect(compareAll(base, cand, UNIT_TIME).map((d) => d.name)).toEqual(['a'])
  })

  it('errors when nothing appears in both sets', () => {
    expect(() => compareAll(new BenchSet(), new BenchSet(), UNIT_TIME))
      .toThrow(/no benchmark appears in both/)
  })
})

describe('geoMean', () => {
  it('is the geometric mean of the ratios', () => {
    expect(geoMean([{ name: 'a', ratio: 0.5 }, { name: 'b', ratio: 2 }])).toBeCloseTo(1, 12)
    expect(geoMean([{ name: 'a', ratio: 0.25 }, { name: 'b', ratio: 0.25 }])).toBeCloseTo(0.25, 12)
  })

  it('errors on an empty delta set', () => {
    expect(() => geoMean([])).toThrow(/empty delta set/)
  })

  it('errors on a non-positive ratio', () => {
    expect(() => geoMean([{ name: 'a', ratio: 0 }])).toThrow(/non-positive ratio/)
  })
})
