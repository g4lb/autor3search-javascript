/**
 * The BenchRunner seam.
 *
 * Everything downstream of here — measure, stats, verdict, pipeline — is
 * language-neutral and knows nothing about Vitest. Adding a second runner
 * means adding a module here, not touching the scoring core.
 *
 * @typedef {object} BenchRunner
 * @property {string} name
 * @property {(dir: string, opts: object) => Promise<import('../../bench/set.js').BenchSet>} run
 *   Runs ONE measured round and returns one observation per benchmark.
 */
import { vitestRunner } from './vitest.js'

export { vitestRunner }

const REGISTRY = new Map([[vitestRunner.name, vitestRunner]])

/**
 * @param {string} name
 * @returns {BenchRunner}
 */
export function getBenchRunner(name) {
  const runner = REGISTRY.get(name)
  if (!runner) {
    throw new Error(
      `${JSON.stringify(name)} is not a registered bench adapter (have: ${[...REGISTRY.keys()].join(', ')})`,
    )
  }
  return runner
}
