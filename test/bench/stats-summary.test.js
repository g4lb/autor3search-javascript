import { describe, expect, it } from 'vitest'
import { binom, countForAlpha, median, minAchievableP, summary } from '../../src/bench/stats.js'

describe('median', () => {
  it('takes the middle value of an odd-length sample', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values of an even-length sample', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('does not mutate its input', () => {
    const v = [3, 1, 2]
    median(v)
    expect(v).toEqual([3, 1, 2])
  })
})

describe('binom', () => {
  it('computes small binomial coefficients', () => {
    expect(binom(5, 2)).toBe(10)
    expect(binom(20, 10)).toBe(184756)
  })

  it('is symmetric in k', () => {
    expect(binom(20, 3)).toBe(binom(20, 17))
  })

  it('returns 0 for an out-of-range k', () => {
    expect(binom(5, -1)).toBe(0)
    expect(binom(5, 6)).toBe(0)
  })

  it('stays finite for large n by dividing in step', () => {
    expect(Number.isFinite(binom(200, 100))).toBe(true)
  })
})

describe('summary', () => {
  it('reports the median as the center', () => {
    expect(summary([1, 2, 3, 4, 5, 6, 7]).center).toBe(4)
  })

  it('produces a bounded interval at six or more observations', () => {
    const s = summary([1, 2, 3, 4, 5, 6])
    expect(s.lo).toBe(1)
    expect(s.hi).toBe(6)
    expect(s.warnings).toEqual([])
  })

  it('narrows the interval as observations accumulate', () => {
    // Same value range as the six-observation sample below, sampled twice as
    // densely (each value duplicated) — this isolates the effect of sample
    // count on interval width. Extending the *range* instead (e.g. sampling
    // 1..12) would not do this: for n=12 the narrowest interval achieving
    // 95% coverage is provably [x(2), x(9)] (0-indexed), a width of 7 on
    // that domain, which is *wider* than the n=6 case's width of 5 — more
    // observations spread over a wider range can still yield only a
    // marginally tighter *relative* interval, not a narrower absolute one.
    const wide = summary([1, 2, 3, 4, 5, 6])
    const narrow = summary([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6])
    expect(narrow.hi - narrow.lo).toBeLessThan(wide.hi - wide.lo)
  })

  it('warns and reports an unbounded interval below six observations', () => {
    const s = summary([1, 2, 3, 4, 5])
    expect(s.lo).toBe(-Infinity)
    expect(s.hi).toBe(Infinity)
    expect(s.warnings).toHaveLength(1)
    expect(s.warnings[0]).toMatch(/at least 6/)
  })

  it('names the confidence level in its warning', () => {
    expect(summary([1, 2, 3]).warnings[0]).toMatch(/95%/)
  })

  it('rejects an empty sample', () => {
    expect(() => summary([])).toThrow(/at least one observation/)
  })

  it('stays correct past the point where 2**n overflows', () => {
    // A direct binom(n,k)/2**n loop returns Infinity then NaN from n=1024 up,
    // exits early on the NaN comparison, and reports a far-too-wide interval
    // with no warning at all.
    const values = Array.from({ length: 2000 }, (_, i) => i)
    const s = summary(values)
    expect(s.warnings).toEqual([])
    expect(s.lo).toBe(955)
    expect(s.hi).toBe(2000 - 1 - 955)
    expect(Number.isFinite(s.hi - s.lo)).toBe(true)
  })

  it('keeps the interval tightening all the way up', () => {
    const width = (n) => {
      const s = summary(Array.from({ length: n }, (_, i) => i))
      return (s.hi - s.lo) / n
    }
    // As a FRACTION of the sample, the interval must keep shrinking.
    expect(width(2000)).toBeLessThan(width(200))
    expect(width(200)).toBeLessThan(width(20))
  })

  it('needs more observations at 99% confidence than at 95%', () => {
    expect(summary([1, 2, 3, 4, 5, 6], 0.99).lo).toBe(-Infinity)
    expect(summary([1, 2, 3, 4, 5, 6, 7, 8], 0.99).lo).toBe(1)
  })
})

describe('minAchievableP', () => {
  it('matches the exact-test floor at each small sample size', () => {
    expect(minAchievableP(2, 2)).toBeCloseTo(0.3333, 4)
    expect(minAchievableP(3, 3)).toBeCloseTo(0.1, 4)
    expect(minAchievableP(4, 4)).toBeCloseTo(0.02857, 5)
    expect(minAchievableP(5, 5)).toBeCloseTo(0.00794, 5)
  })

  it('is 2/C(20,10) at the default count of 10 per side', () => {
    expect(minAchievableP(10, 10)).toBeCloseTo(2 / 184756, 12)
  })

  it('is capped at 1 for a degenerate sample size', () => {
    expect(minAchievableP(1, 1)).toBe(1)
    expect(minAchievableP(0, 5)).toBe(1)
  })
})

describe('countForAlpha', () => {
  it('names the smallest count that can reach a threshold', () => {
    expect(countForAlpha(0.05)).toBe(4)
    expect(countForAlpha(0.0071)).toBe(6)
  })

  it('returns 0 when no practical count reaches the threshold', () => {
    expect(countForAlpha(1e-40)).toBe(0)
  })
})
