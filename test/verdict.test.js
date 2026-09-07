import { describe, expect, it } from 'vitest'
import { REASON, STATUS, decide, exitCode, gate } from '../src/verdict.js'

/** A delta with enough observations that no sample-size warning fires. */
const delta = (over = {}) => ({
  name: 'bench',
  unit: 'sec/op',
  baseCenter: 100,
  candCenter: 90,
  ratio: 0.9,
  pctChange: -10,
  p: 0.001,
  alpha: 0.05,
  significant: true,
  nBase: 10,
  nCand: 10,
  warnings: [],
  ...over,
})

const input = (over = {}) => ({
  deltas: [delta()],
  score: 0.9,
  maxRegressPct: 5,
  minEffectPct: 1,
  ...over,
})

describe('gate', () => {
  it('builds a terminal result for a failed correctness stage', () => {
    const r = gate(STATUS.FAIL, REASON.SCOPE, 'x.js is outside the allowed scope')
    expect(r).toMatchObject({ status: 'FAIL', reason: 'scope_violation', message: expect.any(String) })
  })
})

describe('decide — keeping', () => {
  it('keeps a real, significant improvement', () => {
    const r = decide(input())
    expect(r.status).toBe(STATUS.KEEP)
    expect(r.reason).toBe(REASON.IMPROVED)
    expect(r.score).toBe(0.9)
  })

  it('reports the score as a percentage in its message', () => {
    expect(decide(input()).message).toMatch(/-10\.00%/)
  })
})

describe('decide — the minimum effect floor', () => {
  it('discards a significant improvement smaller than min_effect_pct', () => {
    const r = decide(input({ deltas: [delta({ pctChange: -0.5, ratio: 0.995 })], score: 0.995 }))
    expect(r.status).toBe(STATUS.DISCARD)
    expect(r.reason).toBe(REASON.BELOW_MIN_EFFECT)
  })

  it('says the idea worked when it fails only on effect size', () => {
    const r = decide(input({ deltas: [delta({ pctChange: -0.5, ratio: 0.995 })], score: 0.995 }))
    expect(r.message).toMatch(/a real improvement but below/)
  })

  it('distinguishes an inert change from a too-small one', () => {
    const r = decide(input({ deltas: [delta({ pctChange: 0.1, ratio: 1.001, p: 0.9, significant: false })], score: 1.001 }))
    expect(r.reason).toBe(REASON.NO_IMPROVEMENT)
  })

  it('keeps when min_effect_pct is zero and the change is barely faster', () => {
    const r = decide(input({ deltas: [delta({ pctChange: -0.5, ratio: 0.995 })], score: 0.995, minEffectPct: 0 }))
    expect(r.status).toBe(STATUS.KEEP)
  })
})

describe('decide — the Bonferroni correction', () => {
  it('requires at least one benchmark past alpha/k', () => {
    // Four benchmarks: corrected threshold is 0.0125. p = 0.02 clears the raw
    // alpha but not the corrected one, so nothing qualifies.
    const deltas = Array.from({ length: 4 }, (_, i) =>
      delta({ name: `b${i}`, p: 0.02, pctChange: -10, ratio: 0.9 }),
    )
    const r = decide(input({ deltas, score: 0.9 }))
    expect(r.status).toBe(STATUS.DISCARD)
    expect(r.reason).toBe(REASON.NO_IMPROVEMENT)
  })

  it('keeps when one benchmark clears the corrected threshold', () => {
    const deltas = [
      delta({ name: 'a', p: 0.001, pctChange: -10, ratio: 0.9 }),
      delta({ name: 'b', p: 0.4, pctChange: -1, ratio: 0.99, significant: false }),
      delta({ name: 'c', p: 0.4, pctChange: -1, ratio: 0.99, significant: false }),
      delta({ name: 'd', p: 0.4, pctChange: -1, ratio: 0.99, significant: false }),
    ]
    expect(decide(input({ deltas, score: 0.95 })).status).toBe(STATUS.KEEP)
  })

  it('ignores a significantly SLOWER benchmark when looking for an improvement', () => {
    const r = decide(input({ deltas: [delta({ pctChange: 3, ratio: 1.03, p: 0.001 })], score: 0.9 }))
    expect(r.status).toBe(STATUS.DISCARD)
  })
})

describe('decide — the regression guard', () => {
  it('discards a significant regression beyond the limit, however good the score', () => {
    const deltas = [
      delta({ name: 'fast', p: 0.0001, pctChange: -40, ratio: 0.6 }),
      delta({ name: 'slow', p: 0.0001, pctChange: 12, ratio: 1.12 }),
    ]
    const r = decide(input({ deltas, score: 0.82 }))
    expect(r.status).toBe(STATUS.DISCARD)
    expect(r.reason).toBe(REASON.GUARD_REGRESSION)
    expect(r.regressions.map((d) => d.name)).toEqual(['slow'])
    expect(r.message).toMatch(/slow \+12\.0%/)
  })

  it('tolerates a regression within the limit', () => {
    const deltas = [
      delta({ name: 'fast', p: 0.0001, pctChange: -40, ratio: 0.6 }),
      delta({ name: 'slow', p: 0.0001, pctChange: 3, ratio: 1.03 }),
    ]
    expect(decide(input({ deltas, score: 0.79 })).status).toBe(STATUS.KEEP)
  })

  it('ignores a large but INSIGNIFICANT regression', () => {
    const deltas = [
      delta({ name: 'fast', p: 0.0001, pctChange: -40, ratio: 0.6 }),
      delta({ name: 'noisy', p: 0.6, significant: false, pctChange: 30, ratio: 1.3 }),
    ]
    expect(decide(input({ deltas, score: 0.88 })).status).toBe(STATUS.KEEP)
  })

  it('uses the RAW alpha for the guard, not the Bonferroni-corrected one', () => {
    // Ten benchmarks. The corrected threshold is 0.005; this regression's
    // p = 0.02 misses it but clears the raw alpha, and the guard must still
    // fire — the correction may only ever make accepting a WIN harder.
    const deltas = [
      delta({ name: 'win', p: 0.0001, pctChange: -30, ratio: 0.7 }),
      ...Array.from({ length: 8 }, (_, i) =>
        delta({ name: `n${i}`, p: 0.9, significant: false, pctChange: 0, ratio: 1 }),
      ),
      delta({ name: 'harm', p: 0.02, significant: true, pctChange: 20, ratio: 1.2 }),
    ]
    const r = decide(input({ deltas, score: 0.95 }))
    expect(r.reason).toBe(REASON.GUARD_REGRESSION)
  })
})

describe('decide — warnings', () => {
  it('carries per-delta warnings without changing the decision', () => {
    const r = decide(input({ deltas: [delta({ warnings: ['interval unbounded'] })] }))
    expect(r.status).toBe(STATUS.KEEP)
    expect(r.warnings).toContain('interval unbounded')
  })

  it('deduplicates warnings across deltas', () => {
    const deltas = [
      delta({ name: 'a', warnings: ['same'] }),
      delta({ name: 'b', warnings: ['same'] }),
    ]
    expect(decide(input({ deltas, score: 0.9 })).warnings).toEqual(['same'])
  })

  it('warns when no KEEP was statistically reachable', () => {
    // Five rounds per side floors p at 0.00794; seven benchmarks correct the
    // threshold to 0.00714, which is below that floor for every one of them.
    const deltas = Array.from({ length: 7 }, (_, i) =>
      delta({ name: `b${i}`, nBase: 5, nCand: 5, p: 0.03, pctChange: -10, ratio: 0.9 }),
    )
    const r = decide(input({ deltas, score: 0.9 }))
    expect(r.warnings.join(' ')).toMatch(/no KEEP was reachable/)
    expect(r.warnings.join(' ')).toMatch(/raise count to at least/)
  })

  it('does not warn when at least one benchmark could have cleared the bar', () => {
    const deltas = Array.from({ length: 7 }, (_, i) =>
      delta({ name: `b${i}`, nBase: 10, nCand: 10 }),
    )
    expect(decide(input({ deltas, score: 0.9 })).warnings.join(' ')).not.toMatch(/no KEEP/)
  })
})

describe('exitCode', () => {
  it('maps each status to the code program.md documents', () => {
    expect(exitCode({ status: STATUS.KEEP })).toBe(0)
    expect(exitCode({ status: STATUS.DISCARD })).toBe(1)
    expect(exitCode({ status: STATUS.FAIL })).toBe(2)
    expect(exitCode({ status: STATUS.CRASH })).toBe(3)
  })

  it('reports an aborted experiment as FAIL, never as success', () => {
    expect(exitCode({ status: STATUS.ABORTED })).toBe(2)
  })

  it('reports an unrecognised status as FAIL rather than success', () => {
    expect(exitCode({ status: 'WAT' })).toBe(2)
  })
})
