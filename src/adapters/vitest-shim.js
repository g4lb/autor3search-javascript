/**
 * Stands in for the `vitest` module inside the standalone driver child.
 *
 * The real `bench` throws outside a Vitest runner, so a driver that wants to
 * import a bench file for any purpose OTHER than timing — allocation
 * sampling, CPU profiling — has to supply its own. Registrations land on a
 * global the child reads back; a module-level array would be invisible across
 * the loader boundary.
 */
const registry = () => {
  globalThis.__a3sTasks ??= []
  globalThis.__a3sSuite ??= []
  return globalThis
}

/** Registers one benchmark. `bench.skip` and `bench.only` register too — the
 * driver measures allocation and CPU, where skipping is not meaningful. */
export function bench(name, fn) {
  const g = registry()
  g.__a3sTasks.push({ name: String(name), path: [...g.__a3sSuite, String(name)].join(' > '), fn })
}
bench.skip = bench
bench.only = bench
bench.todo = () => {}

/** Opens a naming scope, so a task's path matches how Vitest names it. */
export function describe(name, fn) {
  const g = registry()
  g.__a3sSuite.push(String(name))
  try {
    fn?.()
  } finally {
    g.__a3sSuite.pop()
  }
}
describe.skip = describe
describe.only = describe

export const suite = describe

/** No-ops, so a bench file that also imports these still loads. */
export const beforeAll = (fn) => fn
export const afterAll = () => {}
export const beforeEach = () => {}
export const afterEach = () => {}
export const test = () => {}
export const it = () => {}
export const expect = () => {
  throw new Error('expect() is not available inside the autor3search driver')
}
export default { bench, describe, suite }
