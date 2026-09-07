/**
 * The statistics behind every verdict — a hand port of the subset of
 * golang.org/x/perf/benchmath that autor3search-go used.
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
