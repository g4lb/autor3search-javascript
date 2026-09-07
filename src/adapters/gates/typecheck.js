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

/**
 * Reports why this gate cannot run here, or null when it can.
 *
 * Always null: the parse fallback works everywhere, so there is no repository
 * where this gate cannot run AT ALL. Degradation is reported separately — see
 * the `degraded` flag in `run` — because a repo with a tsconfig but no
 * installed typescript can still be parse-checked, just not type-checked.
 */
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
      degraded: false,
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
  // `degraded` marks a check WEAKER than the repository asked for: a
  // tsconfig.json is present, so this repo wants real type checking, but
  // typescript is not installed and only a syntax parse was possible. Under
  // gates.typecheck: "on" that is a failure — a user who required type
  // checking must not silently receive syntax checking instead. Under "auto"
  // it runs and says so.
  const degraded = hasTsconfig
  return {
    ran: true,
    ok: failures.length === 0,
    timedOut: false,
    skipped: null,
    degraded,
    detail:
      failures.length > 0
        ? failures.join('\n')
        : degraded
          ? 'parse check ONLY — tsconfig.json is present but typescript is not installed, so types were not checked'
          : 'parse check (no tsconfig.json)',
  }
}
