/**
 * Module-resolution hooks redirecting the `vitest` specifier to our shim.
 *
 * Registered with module.register() (Node >= 20.6) from driver-child.js, so
 * a bench file's `import { bench } from 'vitest'` resolves to
 * vitest-shim.js instead of the real package.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const SHIM = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'vitest-shim.js')).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest' || specifier.startsWith('vitest/')) {
    return { url: SHIM, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
