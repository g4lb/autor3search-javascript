/**
 * The statistics behind every verdict. The estimators follow the method
 * described by golang.org/x/perf/benchmath, implemented here directly; that
 * package is cited for the method, not depended on.
 *
 * The estimator is deliberately distribution-free ("assume nothing"):
 * benchmark timings are not normal, they are right-skewed with occasional
 * large outliers from GC pauses and scheduler preemption, and a mean with a
 * t-interval would be pulled around by exactly those outliers.
 */

/** Confidence level for the reported median interval. */
export const CONFIDENCE = 0.95

/** Rejection threshold for the significance test. */
export const ALPHA = 0.05

/**
 * The median. Uses the average of the two middle values at even length,
 * which is the R-7 quantile at 0.5 and matches benchmath.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  const v = [...values].sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * C(n, k), multiplying and dividing in step so the intermediate value stays
 * near the result rather than overflowing through a factorial.
 *
 * @param {number} n
 * @param {number} k
 * @returns {number}
 */
export function binom(n, k) {
  if (k < 0 || k > n) return 0
  const kk = Math.min(k, n - k)
  let c = 1
  for (let i = 0; i < kk; i++) c = (c * (n - i)) / (i + 1)
  return c
}

/**
 * Summarises one sample: the median, and a distribution-free confidence
 * interval built from order statistics.
 *
 * The interval [x(k), x(n-1-k)] has coverage 1 - 2*P(Bin(n, 1/2) <= k). The
 * widest available interval — the whole range, at k = 0 — has coverage
 * 1 - 2/2^n, which only reaches 95% once n >= 6. Below that NO interval
 * achieves the requested confidence, so rather than quietly reporting the
 * range as though it did, the bounds are reported as infinite and a warning
 * says why. benchmath raises the same warning, and its documentation says it
 * should be shown to the user, so it is carried out of here rather than
 * dropped.
 *
 * @param {number[]} values
 * @param {number} [confidence]
 * @returns {{center: number, lo: number, hi: number, warnings: string[]}}
 */
export function summary(values, confidence = CONFIDENCE) {
  const n = values.length
  if (n === 0) throw new Error('summary needs at least one observation')

  const sorted = [...values].sort((a, b) => a - b)
  const center = median(sorted)
  const warnings = []

  // Largest k whose interval still covers at least `confidence`.
  //
  // The cumulative binomial is accumulated in LOG SPACE, carrying log C(n,k)
  // incrementally. The direct form — binom(n, k) / 2 ** n — overflows to
  // Infinity at n = 1024 and then silently yields 0 and NaN, so the loop exits
  // on a comparison against NaN and returns a k that is neither correct nor
  // conservative, with no warning. Carrying the log also makes this O(n)
  // rather than O(n^2), since binom is no longer recomputed per iteration.
  const logThreshold = Math.log((1 - confidence) / 2)
  let logCoefficient = 0 // log C(n, 0)
  let logCumulative = logCoefficient - n * Math.LN2 // log P(Bin(n, 1/2) <= 0)
  let best = logCumulative <= logThreshold ? 0 : -1
  for (let k = 1; k <= (n - 1) >> 1; k++) {
    logCoefficient += Math.log(n - k + 1) - Math.log(k)
    logCumulative = logAddExp(logCumulative, logCoefficient - n * Math.LN2)
    if (logCumulative <= logThreshold) best = k
    else break
  }

  if (best < 0) {
    warnings.push(
      `confidence interval requires at least 6 observations at ${(confidence * 100).toFixed(0)}% ` +
        `confidence; got ${n}, so the interval around the reported median is unbounded — raise count`,
    )
    return { center, lo: -Infinity, hi: Infinity, warnings }
  }
  return { center, lo: sorted[best], hi: sorted[n - 1 - best], warnings }
}

/**
 * log(exp(a) + exp(b)), computed so the larger term never leaves log space.
 * Summing the probabilities directly would underflow to zero for the tiny
 * per-term values that arise at large n.
 */
function logAddExp(a, b) {
  const max = Math.max(a, b)
  if (max === -Infinity) return max
  return max + Math.log1p(Math.exp(Math.min(a, b) - max))
}

/**
 * The smallest two-sided p-value the Mann-Whitney U test can return for
 * samples of size n1 and n2: 2 / C(n1+n2, n1).
 *
 * The two samples can be maximally separated and the test still only reaches
 * this, because it is the fraction of orderings at least as extreme as the
 * observed one. It reproduces benchmath's generated table exactly (0.3333 at
 * n=2, 0.1000 at 3, 0.02857 at 4, 0.00794 at 5) without duplicating it.
 *
 * @param {number} n1
 * @param {number} n2
 * @returns {number}
 */
export function minAchievableP(n1, n2) {
  if (n1 < 1 || n2 < 1) return 1
  const p = 2 / binom(n1 + n2, n1)
  return p > 1 ? 1 : p
}

/**
 * The smallest number of rounds per side at which the U test can produce a
 * p-value below alpha, or 0 when no practical count does. The search stops at
 * 50, far past any sensible benchmark budget.
 *
 * @param {number} alpha
 * @returns {number}
 */
export function countForAlpha(alpha) {
  for (let n = 2; n <= 50; n++) {
    if (minAchievableP(n, n) < alpha) return n
  }
  return 0
}

/**
 * Largest sample size for which the exact test is enumerated. Above this the
 * normal approximation is used. The default count of 10 rounds per side sits
 * exactly at this limit, so a default run gets the exact test.
 */
export const EXACT_LIMIT = 10

/**
 * Two-sided Mann-Whitney U test (a rank-sum test).
 *
 * Chosen over a t-test because it assumes nothing about the shape of the
 * distribution. Benchmark timings are right-skewed with occasional large
 * outliers from GC pauses and scheduler preemption; a t-test's normality
 * assumption is not merely unmet, it is unmet in the direction that
 * manufactures false significance.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {{p: number, n1: number, n2: number, exact: boolean, warnings: string[]}}
 */
export function mannWhitneyU(a, b) {
  const n1 = a.length
  const n2 = b.length
  if (n1 < 2 || n2 < 2) {
    throw new Error(`Mann-Whitney needs at least 2 observations per side, got ${n1}/${n2}`)
  }

  const warnings = []
  const { rankSumA, tieGroups, allTied } = rank(a, b)

  if (allTied) {
    warnings.push(
      'the two samples are indistinguishable — every observation is identical, so no test can separate them',
    )
    return { p: 1, n1, n2, exact: false, warnings }
  }

  // U1 is the count of (a, b) pairs in which a wins, derived from the rank sum.
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2
  const u2 = n1 * n2 - u1
  const u = Math.min(u1, u2)

  const exact = n1 <= EXACT_LIMIT && n2 <= EXACT_LIMIT && tieGroups.length === 0
  const p = exact ? exactP(n1, n2, u) : normalP(n1, n2, u, tieGroups)

  // The floor below which this pair of sample sizes cannot reach, however far
  // apart the samples are. Surfaced here so a caller can tell "no difference"
  // from "this experiment was never able to show one".
  if (minAchievableP(n1, n2) >= ALPHA) {
    warnings.push(
      `with ${n1}/${n2} observations the test cannot produce a p-value below ` +
        `${minAchievableP(n1, n2).toFixed(5)}, so it can never reach alpha=${ALPHA} however large the ` +
        `difference is — raise count to at least ${countForAlpha(ALPHA)}`,
    )
  }
  return { p: Math.min(1, p), n1, n2, exact, warnings }
}

/**
 * Assigns midranks across the pooled samples and returns the rank sum of a,
 * along with the sizes of every tie group (used by the tie correction).
 */
function rank(a, b) {
  const pooled = [
    ...a.map((value) => ({ value, fromA: true })),
    ...b.map((value) => ({ value, fromA: false })),
  ].sort((x, y) => x.value - y.value)

  let rankSumA = 0
  const tieGroups = []
  for (let i = 0; i < pooled.length; ) {
    let j = i
    while (j + 1 < pooled.length && pooled[j + 1].value === pooled[i].value) j++
    const size = j - i + 1
    // Midrank: the average of the 1-based ranks this tie group spans.
    const midrank = (i + 1 + (j + 1)) / 2
    for (let k = i; k <= j; k++) {
      if (pooled[k].fromA) rankSumA += midrank
    }
    if (size > 1) tieGroups.push(size)
    i = j + 1
  }
  return { rankSumA, tieGroups, allTied: tieGroups.length === 1 && tieGroups[0] === pooled.length }
}

/**
 * Exact two-sided p by enumerating the null distribution of U.
 *
 * counts[u] is the number of ways to arrange n1 items among n1+n2 positions
 * that produce statistic u, from the recurrence
 *   N(n1, n2, u) = N(n1-1, n2, u - n2) + N(n1, n2-1, u)
 * evaluated as a rolling table over u. At n1 = n2 = 10 this is 100 * 101
 * table updates, which is instant.
 */
function exactP(n1, n2, u) {
  const maxU = n1 * n2

  // f[j][x] = the number of arrangements of i A's and j B's whose statistic is
  // x, rolled forward over i. The recurrence is
  //
  //   f(i, j, x) = f(i-1, j, x-j) + f(i, j-1, x)
  //
  // Place an A last and it sits after all j B's, contributing j to the
  // statistic; place a B last and it contributes nothing.
  //
  // The tempting shortcut — letting each of the n1 A's independently take any
  // value in 0..n2 — is WRONG: it counts ordered compositions, (n2+1)^n1
  // rather than C(n1+n2, n1) arrangements (25,937,424,601 instead of 184,756
  // at n1=n2=10). It agrees with this one only at u=0, where a single
  // arrangement is possible either way, so a test that checks only the
  // p-value floor cannot tell the two apart while every intermediate p-value
  // is wrong.
  let f = Array.from({ length: n2 + 1 }, () => new Float64Array(maxU + 1))
  for (let j = 0; j <= n2; j++) f[j][0] = 1 // i=0: all B's, statistic 0
  for (let i = 1; i <= n1; i++) {
    const next = Array.from({ length: n2 + 1 }, () => new Float64Array(maxU + 1))
    for (let j = 0; j <= n2; j++) {
      for (let x = 0; x <= maxU; x++) {
        let v = x - j >= 0 ? f[j][x - j] : 0 // f(i-1, j, x-j)
        if (j > 0) v += next[j - 1][x] // f(i, j-1, x)
        next[j][x] = v
      }
    }
    f = next
  }

  const total = binom(n1 + n2, n1)
  let cumulative = 0
  for (let x = 0; x <= u; x++) cumulative += f[n2][x]
  return Math.min(1, (2 * cumulative) / total)
}

/**
 * Normal approximation with the standard tie correction. Used above the exact
 * limit and whenever the pooled samples contain ties.
 */
function normalP(n1, n2, u, tieGroups) {
  const n = n1 + n2
  let tieTerm = 0
  for (const t of tieGroups) tieTerm += t ** 3 - t
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)))
  if (variance <= 0) return 1
  const z = (u - (n1 * n2) / 2) / Math.sqrt(variance)
  return Math.min(1, 2 * normalCdf(-Math.abs(z)))
}

/** Standard normal CDF, via the complementary error function. */
function normalCdf(z) {
  return 0.5 * erfc(-z / Math.SQRT2)
}

/**
 * Complementary error function. Numerical Recipes' Chebyshev approximation,
 * accurate to about 1.2e-7 relative — far tighter than any p-value here is
 * interpreted to.
 */
function erfc(x) {
  const z = Math.abs(x)
  const t = 2 / (2 + z)
  const ty = 4 * t - 2
  const coefficients = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
    -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
    -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
  ]
  let d = 0
  let dd = 0
  for (let j = coefficients.length - 1; j > 0; j--) {
    const tmp = d
    d = ty * d - dd + coefficients[j]
    dd = tmp
  }
  const result = t * Math.exp(-z * z + 0.5 * (coefficients[0] + ty * d) - dd)
  return x >= 0 ? result : 2 - result
}

/**
 * @typedef {object} Delta
 * @property {string} name
 * @property {string} unit
 * @property {number} baseCenter median of the baseline observations
 * @property {number} candCenter median of the candidate observations
 * @property {number} ratio candCenter / baseCenter; below 1 is faster
 * @property {number} pctChange (ratio - 1) * 100
 * @property {number} p Mann-Whitney two-sided p-value
 * @property {number} alpha rejection threshold, uncorrected
 * @property {boolean} significant p < alpha, with NO multiple-comparison correction
 * @property {number} nBase
 * @property {number} nCand
 * @property {string[]} warnings
 */

/**
 * Compares one benchmark's unit across two measurement sets.
 *
 * `significant` here always means "significant at the raw, uncorrected
 * alpha". That is the honest statistic a human or an agent should read. A
 * Bonferroni correction that gates a keep/reject decision is applied
 * elsewhere, on top of this — it is a decision threshold, not a
 * redefinition of the word.
 *
 * @param {import('./set.js').BenchSet} base
 * @param {import('./set.js').BenchSet} cand
 * @param {string} name
 * @param {string} unit
 * @returns {Delta}
 */
export function compare(base, cand, name, unit) {
  const bv = base.values(name, unit)
  if (!bv) throw new Error(`baseline has no ${unit} for ${name}`)
  const cv = cand.values(name, unit)
  if (!cv) throw new Error(`candidate has no ${unit} for ${name}`)
  if (bv.length < 2 || cv.length < 2) {
    throw new Error(`${name}: need at least 2 observations per side, got ${bv.length}/${cv.length}`)
  }

  const bSum = summary(bv)
  const cSum = summary(cv)
  if (bSum.center === 0) {
    throw new Error(`${name}: baseline ${unit} median is zero, cannot form a ratio`)
  }
  const test = mannWhitneyU(bv, cv)
  const ratio = cSum.center / bSum.center

  return {
    name,
    unit,
    baseCenter: bSum.center,
    candCenter: cSum.center,
    ratio,
    pctChange: (ratio - 1) * 100,
    p: test.p,
    alpha: ALPHA,
    significant: test.p < ALPHA,
    nBase: test.n1,
    nCand: test.n2,
    // Deduplicated: the two summaries warn about the same sample size in the
    // same words, and printing that twice per benchmark buries the distinct
    // warnings among duplicates.
    warnings: [...new Set([...bSum.warnings, ...cSum.warnings, ...test.warnings])],
  }
}

/**
 * Compares every benchmark present in both sets, sorted by name.
 *
 * Strict in one direction: a benchmark measured at baseline but missing from
 * the candidate is an error, not a skip. A benchmark that disappears cannot
 * be checked for regressions — which is exactly how an agent would hide one.
 * A benchmark the candidate added is ignored rather than an error, because a
 * new benchmark cannot have regressed against a baseline that never ran it.
 *
 * @param {import('./set.js').BenchSet} base
 * @param {import('./set.js').BenchSet} cand
 * @param {string} unit
 * @returns {Delta[]}
 */
export function compareAll(base, cand, unit) {
  const out = []
  const missing = []
  for (const name of base.names()) {
    if (!base.has(name, unit)) continue
    if (!cand.has(name, unit)) {
      missing.push(name)
      continue
    }
    out.push(compare(base, cand, name, unit))
  }
  if (missing.length > 0) {
    throw new Error(
      `benchmark(s) measured at baseline but missing from the candidate: ${missing.sort().join(', ')} — ` +
        `a benchmark that disappears cannot be checked for regressions`,
    )
  }
  if (out.length === 0) throw new Error('no benchmark appears in both baseline and candidate')
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The geometric mean of the deltas' ratios — the single score the agent
 * optimizes. Below 1 is an overall speedup.
 *
 * Computed in log space so a long list of small ratios cannot underflow.
 *
 * @param {Delta[]} deltas
 * @returns {number}
 */
export function geoMean(deltas) {
  if (deltas.length === 0) throw new Error('geoMean of an empty delta set')
  let sum = 0
  for (const d of deltas) {
    if (!(d.ratio > 0)) throw new Error(`${d.name}: non-positive ratio ${d.ratio}`)
    sum += Math.log(d.ratio)
  }
  return Math.exp(sum / deltas.length)
}
