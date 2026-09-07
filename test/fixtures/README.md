# Fixtures

`vitest-bench.json` is the real output of Vitest's benchmark run, captured from
**Vitest 2.1.9** (see `node_modules/vitest/package.json`), over a bench file
declaring `strings > concat`, `strings > join`, and a top-level `toplevel`:

```js
import { bench, describe } from 'vitest'

describe('strings', () => {
  bench('concat', () => { let s = ''; for (let i = 0; i < 100; i++) s += 'x' })
  bench('join', () => { const a = []; for (let i = 0; i < 100; i++) a.push('x'); a.join('') })
})

bench('toplevel', () => { Math.sqrt(2) })
```

## The working capture command

The plan's guessed command, `vitest bench --run --reporter=json --outputFile=<file>`,
**does not work**: `bench` has no built-in reporter named `json` registered
under `--reporter`, and Vitest tries (and fails) to load a *custom* reporter
module literally named `json`. The actual working invocation uses `bench`'s
own dedicated JSON-output flag instead:

    npx vitest bench --run --outputJson=bench.json --root=<project root>

(confirmed via `vitest bench --help`, which lists `--outputJson <filename>`
as a bench-only option, distinct from the generic `--reporter`/`--outputFile`
pair used by `vitest run`).

## The actual top-level shape

Structurally this matches what the plan guessed:

```
{
  files: [
    {
      filepath: string,          // absolute path to the .bench.js file
      groups: [
        {
          fullName: string,      // "<relative file path>[ > <describe> ...]"
          benchmarks: [
            {
              id: string,
              name: string,      // the leaf name passed to bench()
              rank: number,
              rme: number,
              samples: number[], // OBSERVED EMPTY ([]) in this capture — see below
              totalTime: number,
              min: number, max: number, mean: number, median: number,
              hz: number, period: number, variance: number, sd: number,
              sem: number, df: number, critical: number, moe: number,
              p75: number, p99: number, p995: number, p999: number,
              sampleCount: number,
            },
            ...
          ],
        },
        ...
      ],
    },
    ...
  ],
}
```

A group with no enclosing `describe` (the top-level `toplevel` bench) still
gets a group, with `fullName` equal to the bare relative file path (no ` > `
suffix); a group inside a `describe('strings', ...)` gets
`fullName: "src/demo.bench.js > strings"`. `parseVitestBench` builds its task
path as `` `${group.fullName} > ${name}` `` (or just `name` if `fullName` is
empty), so the file path and any enclosing suites are always included, and
`config.benchmarks` can still select on the bare leaf `name`.

## Time unit

All of `min`, `max`, `mean`, `median`, `period`, `p75`, `p99`, `p995`, `p999`
are in **MILLISECONDS** — confirmed by cross-checking against `hz`: for the
`toplevel` benchmark, `hz = 36480231.93`, so `1 / hz = 2.7412e-8` seconds
`= 2.7412e-5` milliseconds, which is exactly the reported `period`/`mean`
(`2.741210642518024e-05`). This matches the plan's guess.
`parseVitestBench` converts to seconds, because `sec/op` (`UNIT_TIME`) is the
unit the scoring core works in.

## One real discrepancy worth flagging: `samples` is empty

In this capture, every benchmark's `samples` array is `[]`, even though the
summary table printed to the terminal (and `sampleCount`) shows hundreds of
thousands of underlying iterations. Tinybench does not retain raw samples in
the JSON report by default. `parseVitestBench` therefore relies on `median`
(falling back to `mean`, and only as a last resort to a median computed over
`samples`, which in practice will rarely if ever be reached from a real
Vitest capture) rather than assuming `samples` is populated.

## Re-capturing

If a Vitest upgrade changes the shape, re-capture this file with the command
above and adjust the parser — never edit the fixture to match the parser.
