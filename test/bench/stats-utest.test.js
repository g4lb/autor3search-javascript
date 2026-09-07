import { describe, expect, it } from 'vitest'
import { mannWhitneyU, minAchievableP } from '../../src/bench/stats.js'

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i)

describe('mannWhitneyU', () => {
  it('returns the exact floor for maximally separated samples', () => {
    const r = mannWhitneyU([1, 2, 3, 4], [10, 11, 12, 13])
    expect(r.exact).toBe(true)
    expect(r.p).toBeCloseTo(minAchievableP(4, 4), 12)
  })

  it('reaches the documented floor at ten per side', () => {
    const r = mannWhitneyU(range(10, 0), range(10, 100))
    expect(r.p).toBeCloseTo(2 / 184756, 12)
  })

  it('is symmetric in its arguments', () => {
    const a = [1, 4, 6, 9, 11, 13]
    const b = [2, 3, 7, 8, 12, 14]
    expect(mannWhitneyU(a, b).p).toBeCloseTo(mannWhitneyU(b, a).p, 12)
  })

  it('reports a high p for fully interleaved samples', () => {
    const r = mannWhitneyU([1, 3, 5, 7, 9, 11], [2, 4, 6, 8, 10, 12])
    expect(r.p).toBeGreaterThan(0.5)
  })

  it('is unchanged when the two samples are swapped', () => {
    const a = [1, 2, 3, 6]
    const b = [4, 5, 7, 8]
    expect(mannWhitneyU(a, b).p).toBeCloseTo(mannWhitneyU(b, a).p, 12)
  })

  it('never returns a p-value above 1', () => {
    const r = mannWhitneyU([1, 2, 3, 4, 5], [1.5, 2.5, 3.5, 4.5, 5.5])
    expect(r.p).toBeLessThanOrEqual(1)
  })

  it('matches the published exact table for n1 = n2 = 4', () => {
    // Two-sided p at U = 0..4 is .0286 .0571 .1143 .2000 .3429 — the standard
    // Mann-Whitney table. Each pair below is built to land on one U value.
    // (U counts pairs where an `a` exceeds a `b`.)
    expect(mannWhitneyU([1, 2, 3, 4], [5, 6, 7, 8]).p).toBeCloseTo(0.0286, 4) // U=0
    expect(mannWhitneyU([1, 2, 3, 5], [4, 6, 7, 8]).p).toBeCloseTo(0.0571, 4) // U=1
    expect(mannWhitneyU([1, 2, 3, 6], [4, 5, 7, 8]).p).toBeCloseTo(0.1143, 4) // U=2
    expect(mannWhitneyU([1, 2, 3, 7], [4, 5, 6, 8]).p).toBeCloseTo(0.2, 4) // U=3
  })

  it('counts arrangements, not ordered compositions', () => {
    // Guards the exact DP against the shortcut that lets each of the n1 items
    // independently take 0..n2. That counts (n2+1)^n1 rather than
    // C(n1+n2, n1), and agrees with the correct answer ONLY at u=0 — so the
    // p-value-floor test above cannot catch it. This interleaved case can:
    // the wrong DP gives a visibly different number here.
    expect(mannWhitneyU([1, 3, 5, 7, 9, 11], [2, 4, 6, 8, 10, 12]).p).toBeCloseTo(0.699134, 5)
  })

  it('reports the two sample sizes', () => {
    const r = mannWhitneyU(range(6), range(8, 50))
    expect(r.n1).toBe(6)
    expect(r.n2).toBe(8)
  })

  it('falls back to the normal approximation above the exact limit', () => {
    const r = mannWhitneyU(range(11), range(11, 100))
    expect(r.exact).toBe(false)
    expect(r.p).toBeLessThan(0.001)
  })

  it('falls back to the normal approximation when the samples contain ties', () => {
    const r = mannWhitneyU([1, 1, 2, 3, 4], [1, 5, 6, 7, 8])
    expect(r.exact).toBe(false)
    expect(Number.isFinite(r.p)).toBe(true)
  })

  it('applies the tie correction rather than dividing by zero', () => {
    const r = mannWhitneyU([5, 5, 5, 5, 5, 5], [5, 5, 5, 5, 5, 5])
    expect(r.p).toBe(1)
    expect(r.warnings.join(' ')).toMatch(/indistinguishable/)
  })

  it('warns when the sample sizes cannot reach the default alpha', () => {
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6])
    expect(r.warnings.join(' ')).toMatch(/cannot produce a p-value below/)
  })

  it('does not warn at a sample size that can reach alpha', () => {
    const r = mannWhitneyU(range(10), range(10, 100))
    expect(r.warnings).toEqual([])
  })

  it('rejects a sample with fewer than two observations', () => {
    expect(() => mannWhitneyU([1], [1, 2, 3])).toThrow(/at least 2 observations/)
  })
})
