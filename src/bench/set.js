/**
 * The container for benchmark measurements: every observation of every unit,
 * for every benchmark, in the order it was observed.
 *
 * One measured ROUND contributes exactly one observation per benchmark per
 * unit. See src/measure.js and the spec's section 3.2 for why the
 * per-iteration samples inside a round are never recorded here.
 */

/** The scored unit: seconds per operation. */
export const UNIT_TIME = 'sec/op'

/**
 * The hint unit: approximate bytes allocated per operation. Never scored,
 * and never able to trip the regression guard. See src/adapters/driver.js.
 */
export const UNIT_BYTES = 'bytes/op'

export class BenchSet {
  constructor() {
    /** @type {Map<string, {name: string, base: string, metrics: Map<string, {unit: string, values: number[]}>}>} */
    this.series = new Map()
  }

  /**
   * Records one observation.
   *
   * @param {string} name full task path, e.g. "x.bench.js > parse > big"
   * @param {string} base leaf benchmark name, what config.benchmarks selects on
   * @param {string} unit
   * @param {number} value
   */
  record(name, base, unit, value) {
    let ser = this.series.get(name)
    if (!ser) {
      ser = { name, base, metrics: new Map() }
      this.series.set(name, ser)
    }
    let metric = ser.metrics.get(unit)
    if (!metric) {
      metric = { unit, values: [] }
      ser.metrics.set(unit, metric)
    }
    metric.values.push(value)
  }

  /** @returns {string[]} every benchmark name, sorted. */
  names() {
    return [...this.series.keys()].sort()
  }

  /** @returns {string[]} every base name, sorted and deduplicated. */
  bases() {
    return [...new Set([...this.series.values()].map((s) => s.base))].sort()
  }

  /**
   * @returns {number[] | null} a defensive copy of the observations, so a
   * caller that sorts or mutates the result cannot corrupt the stored data.
   */
  values(name, unit) {
    const metric = this.series.get(name)?.metrics.get(unit)
    return metric ? [...metric.values] : null
  }

  /**
   * Answers the question `values` is usually asked only to answer, without
   * its defensive copy.
   */
  has(name, unit) {
    return this.series.get(name)?.metrics.has(unit) ?? false
  }

  /** Appends every observation in other into this set, preserving order. */
  add(other) {
    for (const name of other.names()) {
      const ser = other.series.get(name)
      for (const [unit, metric] of ser.metrics) {
        for (const value of metric.values) this.record(name, ser.base, unit, value)
      }
    }
  }

  /**
   * Returns a new, independent set holding the subset whose base names appear
   * in `bases`. An empty list selects everything. Selecting on the base is
   * what lets a config say "parse" and still match "parse > big".
   */
  selectByBase(bases) {
    const want = bases.length === 0 ? null : new Set(bases)
    const out = new BenchSet()
    for (const name of this.names()) {
      const ser = this.series.get(name)
      if (want && !want.has(ser.base)) continue
      for (const [unit, metric] of ser.metrics) {
        for (const value of metric.values) out.record(name, ser.base, unit, value)
      }
    }
    return out
  }
}
