/**
 * The build gate.
 *
 * A TypeScript repository gets `tsc --noEmit`. A plain-JavaScript repository
 * has no build step, but it must still get a real "is this even valid code"
 * gate — otherwise a candidate with a syntax error would reach the test gate
 * and be reported as a FAILING TEST rather than as a CRASH, losing exactly
 * the distinction the exit codes exist to draw. So it gets a parse of every
 * in-scope source file instead.
 *
 * The parse fallback reuses discover.js's per-extension plugin choice
 * (`pluginsFor`): `jsx` must not be enabled for a plain `.ts` file, where
 * `<number>value` is a legacy type assertion rather than an unclosed JSX
 * element. Hardcoding a single plugin list here would silently reject valid
 * TypeScript that discover.js itself parses correctly.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { createMatcher } from '../../scope.js'
import { SOURCE_EXTS, pluginsFor } from '../../discover.js'
import { Runner } from '../../runner.js'
import { resolveFrom, walkSources } from './util.js'

export const name = 'typecheck'

/** Reports why this gate cannot run here, or null when it can. */
export async function unavailable() {
  return null // the parse fallback always works
}

export async function run(dir, opts) {
  const hasTsconfig = await stat(join(dir, 'tsconfig.json')).then(
    () => true,
    () => false,
  )
  const tsc = hasTsconfig ? resolveFrom(dir, 'typescript/bin/tsc') : null

  if (tsc) {
    const result = await new Runner(dir, opts.timeoutMs, opts.log).run(process.execPath, [tsc, '--noEmit'])
    return {
      ran: true,
      ok: result.ok(),
      timedOut: result.timedOut,
      skipped: null,
      detail: result.ok() ? 'tsc --noEmit' : result.tail(30),
    }
  }

  const matcher = createMatcher(opts.scope)
  const failures = []
  for (const rel of await walkSources(dir, SOURCE_EXTS)) {
    if (!matcher.match(rel)) continue
    try {
      parse(await readFile(join(dir, rel), 'utf8'), {
        sourceType: 'unambiguous',
        plugins: pluginsFor(rel),
      })
    } catch (err) {
      failures.push(`${rel}: ${err.message}`)
      if (failures.length >= 20) break
    }
  }
  return {
    ran: true,
    ok: failures.length === 0,
    timedOut: false,
    skipped: null,
    detail: failures.length === 0 ? 'parse check (no tsconfig.json)' : failures.join('\n'),
  }
}
