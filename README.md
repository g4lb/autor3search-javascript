# autor3search-javascript

An autonomous performance-optimization harness for JavaScript repositories. You
point a coding agent at your repository, run four commands, hand the agent
`program.md`, and go to sleep. The agent proposes one performance change at a
time; the harness gates it for correctness, measures it against a pinned
baseline, and returns a verdict — `KEEP` or `DISCARD` — that the agent cannot
argue with, weaken, or reinterpret. In the morning `report` tells you what
happened.

This is a port of [`autor3search-go`](https://github.com/g4lb/autor3search-go),
which is itself a descendant of karpathy/autoresearch. The discipline is
carried across deliberately: frozen tests, out-of-tree state, interleaved A/B
measurement, an honest significance test, and a single scalar the agent
cannot game. What changed in the port is described in full in
[Limitations](#limitations) below — most importantly, this harness is not a
compiled binary.

## Start here

Paste this into your coding agent's context, in your repository, with
`autor3search-javascript` installed (`npm i -g autor3search-javascript`):

```
Run these in order, stopping to check each one:

1. autor3search-javascript init
2. Review .autor3search/config.yaml and program.md, then:
   git add -A && git commit -m "autor3search-javascript init"
3. autor3search-javascript doctor
4. autor3search-javascript baseline -tag <a short slug, e.g. today's date>

Then read program.md in full and follow it exactly.
```

The rules that make this safe to leave running overnight, all of which
`program.md` restates in force:

- Never edit `program.md`, `.autor3search/config.yaml`, or `results.tsv`.
  They are how the harness stays honest about what it measured and why.
- Never pass `--force` to anything.
- One idea per experiment. Batching hides which change did what.
- Commit before every `eval` — `eval` scores whatever is on disk against
  whatever is at HEAD.
- `KEEP` means the commit stays. Anything else (`DISCARD`, `FAIL`, `CRASH`,
  `ABORTED`) means `git reset --hard HEAD~1`.

## The idea

| Owns | Belongs to |
|---|---|
| Gating (scope, config integrity, frozen files, correctness), measuring, scoring | the harness |
| Your application source | the agent, inside `scope` |
| `program.md` and `.autor3search/config.yaml` | you |
| Frozen test/bench copies, the baseline record, the pinned measurement worktree | the user cache, outside the repository |

`*.test.*`, `*.spec.*` and `*.bench.*` files are frozen at `baseline` time and
restored before every `eval`. The agent may read them, may complain about
them in its `-desc`, but cannot change what they check or what they measure.
Everything the verdict depends on lives outside the repository the agent is
editing. The scope gate also rejects dependency files and any Vitest/Vite
config outright, because those are loaded by the bench runner itself — an
ordinary, in-scope config file could otherwise redirect what a frozen
benchmark imports, or stub out the code path it measures, without the frozen
copy changing by one byte. That closes the config route specifically; it is
not a claim that nothing else the agent does inside the repo can move the
goalposts — see [Limitations](#limitations) for what is still open.

## Quick start

```
autor3search-javascript init                    # discovers benchmarks, writes config + program.md
git add -A && git commit -m "autor3search-javascript init"
autor3search-javascript doctor                  # is this machine fit to measure on?
autor3search-javascript baseline -tag sep8       # creates the run branch, freezes tests+benches, pins HEAD
```

The commit between `init` and `baseline` matters: `baseline` refuses a dirty
working tree, because a baseline pinned against what's on disk rather than
what's in git could never be reproduced — the pinned worktree it creates is a
git worktree checked out at a real commit, and there has to be one.

## Watching a run, and stopping it

`autor3search-javascript status` shows where things stand without touching
anything:

```
run tag        demo
branch         autor3search-javascript/demo  (checked out)
baseline       bdf3c4c  (run started here)
measuring vs   50c69c7  (advanced past the baseline by earlier KEEPs)
worktree       /Users/you/Library/Caches/autor3search-javascript/.../baseline-worktree
experiments    1 run  (1 keep, 0 discard, 0 fail, 0 crash)  — next is #2
eval           idle
stop           not requested
```

Three ways to end a run, in increasing order of force:

1. **`autor3search-javascript stop`** — a graceful request. The experiment
   under way finishes, is measured and scored normally; the agent sees
   `"stop_requested": true` on that verdict, applies it as usual (`KEEP`
   stays, anything else resets), then exits the loop. Nothing is thrown away.
2. **`autor3search-javascript stop --force`** — writes the same request, then
   sends `SIGTERM` to the running `eval`, which tears down its own child
   process groups so no Vitest worker is left burning CPU. The agent sees
   `"status": "ABORTED"`, exit code 2, and no `results.tsv` row — nothing was
   measured, so nothing was recorded. `stop --force` reports what HEAD looks
   like afterward; it does not touch the repository for you.
3. **Ctrl+C** — the same abort path as `stop --force`, sent directly to a
   foreground `eval`.

`autor3search-javascript stop --clear` cancels a pending stop request so the
loop continues — that is your decision, never the agent's to make on its own.

## Commands

| Command | Does |
|---|---|
| `init` | Scans the repo, discovers benchmarks by parsing (not running) them, writes `.autor3search/config.yaml` and `program.md`. Refuses if it finds no benchmarks. |
| `doctor` | Reports whether this machine can measure reliably: Node/git versions, CPU count and load, whether Vitest resolves, power state, thermal state, disk space. Informational only — always exits 0. |
| `baseline` | Creates the run branch, freezes every test and bench file as a golden copy, pins a git worktree at the current commit, records the config hash. Refuses a dirty tree, an existing `results.tsv`, a reused tag, or a repo with no benchmarks. |
| `profile` | Runs the declared benchmarks under `--cpu-prof`/`--heap-prof` and prints the hottest self-time functions, plus where the raw profiles were written. |
| `eval` | Runs one experiment: scope check, config-integrity check, restores any frozen file the agent touched, runs the correctness gates, measures candidate against baseline (interleaved), scores, and returns a verdict. The only command that decides anything. |
| `status` | Read-only snapshot: branch, baseline, measurement pointer, worktree, experiment counts, whether `eval` is running, whether a stop is pending. |
| `stop` | Requests (or, with `--force`, forces) the run to end. `--clear` cancels a pending request. |
| `report` | Summarizes `results.tsv`: counts by status, cumulative speedup (the product of every kept score), and the largest individual wins. |
| `version` | Prints the installed version and commit. |

Every command accepts `-C <dir>` to run against a repository other than the
current directory.

## Where run state lives

Everything the score depends on — the frozen golden copies, the baseline
record, the pinned measurement worktree — is written to:

```
<user cache>/autor3search-javascript/<repo hash>/<tag>/
```

(`~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux,
`%LOCALAPPDATA%` on Windows). `<repo hash>` is a hash of the repository's real
absolute path, so two checkouts of the same project never collide and never
share state.

Set `AUTOR3SEARCH_JAVASCRIPT_STATE_HOME` to relocate it — a relative path is
refused outright, because it would resolve differently depending on which
directory each command happened to be run from, and `eval` run from a
subdirectory would then silently address different state than `stop` run from
the repository root.

Every directory the harness creates there is mode `0700`, and on POSIX systems
each level from the state home down is checked before it is used: a directory
owned by another user, or one that group or others can write, is refused with
the `chmod` that fixes it. This matters because the frozen store and its
manifest both live here — whoever can write to them can replace the benchmarks
the score is measured against, consistently enough that the hash check still
passes. Under the default cache location the parent already restricts access;
the check is what makes `AUTOR3SEARCH_JAVASCRIPT_STATE_HOME` safe to point at a
shared directory. Windows reports synthetic mode bits and has no owner to
compare against, so the check is skipped there rather than made to look like it
ran.

## Worked example

`test/e2e.test.js` builds this exact scenario from
`test/helpers/bench-repo.js`; `testdata/demo/README.md` documents it in the
repository. A word counter, written badly on purpose:

```js
// the slow version
export function countWords(s) {
  const counts = {}
  for (const field of s.split(/\s+/)) {
    let word = ''
    for (const ch of field) {
      const lower = ch.toLowerCase()
      if (/[a-z0-9]/.test(lower)) word = word + lower
    }
    if (word !== '') counts[word] = (counts[word] ?? 0) + 1
  }
  return counts
}
```

with a frozen test (`src/wordcount.test.js`) checking its behaviour and a
frozen benchmark (`src/wordcount.bench.js`) measuring it on a fixed input.
Both are restored before every `eval`, so a candidate has to keep the exact
same behaviour to be scored at all. The candidate:

```js
// the fast version
export function countWords(s) {
  const counts = new Map()
  for (const field of s.split(' ')) {
    let word = ''
    for (let i = 0; i < field.length; i++) {
      const c = field.charCodeAt(i)
      if (c >= 65 && c <= 90) word += String.fromCharCode(c + 32)
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) word += field[i]
    }
    if (word !== '') counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return Object.fromEntries(counts)
}
```

replaces the regex-per-character scan and string concatenation with charcode
comparisons and a `Map`.

This is a real run, not an illustration — `init`, `doctor`, `baseline -tag
demo`, then the swap above, then `eval`, all against the code shown here, on
a MacBook Pro (Apple M5, 10 logical cores), macOS Darwin 25.6.0, Node
v22.23.1:

| | baseline | candidate | change | p |
|---|---|---|---|---|
| `countWords` (ns/op) | 168,105 | 77,333 | **−54.00%** | 0.00001 |

```
VERDICT: KEEP (improved) — score 0.4600 (-54.00%)
```

`score` is the geometric mean of `candidate/baseline` across the declared
benchmarks (here, one), so with a single benchmark it equals the ratio
directly: 0.46, i.e. 2.17x faster. Run it yourself — noise is real, and on a
busier machine or a shorter `count` this same diff can land as a `DISCARD`
instead; that is not a bug, it is the point.

## What the harness enforces

| Try this | The harness |
|---|---|
| Weaken a test | Restored from the frozen copy before every `eval` |
| Add an "easier" benchmark | Rejected: a new file matching `*.bench.*` not present at baseline is `new_test_file` |
| Rewrite the benchmark to measure something trivial | Restored too — bench files are frozen exactly like test files |
| Symlink a frozen file, or a directory on its path | Refused: `symlink_swap` |
| Hard-link over a frozen file | Refused: `hardlink_swap` |
| Edit a file outside `scope` | `scope_violation`, checked before anything is built or measured |
| Bank ordinary noise as a win | The Mann-Whitney test behind `significant` has to clear it first |
| Speed up A by wrecking B | The regression guard trips on B alone, discarding the whole change |
| Change a dependency (`package.json`, any lockfile) | Rejected outright, regardless of `scope` |
| Loosen `max_regress_pct` or `count` mid-run | `config.yaml`'s hash is pinned at `baseline`; any change fails with `config_changed` |
| Compare against a stale, cached baseline | Every `eval` re-measures both sides, interleaved, in the same process |
| Coast on an earlier win forever | The measurement baseline advances to the just-kept commit after every `KEEP`, so the next `eval` has to earn its own improvement |

## Scoring

`score` is the geometric mean, across the declared benchmarks, of
`candidate_time / baseline_time`:

```
score = exp( mean( log(candidate_i / baseline_i) ) )   for i in benchmarks
```

below 1 is faster. A `KEEP` requires **all** of:

1. **No regression guard trips.** Any benchmark that got significantly
   *worse* — significant at the raw, uncorrected `alpha` (0.05) and past
   `max_regress_pct` — discards the whole experiment, regardless of how good
   the overall score is. This check deliberately skips the Bonferroni
   correction used below: correcting here would only make the guard *less*
   sensitive to harm, which is backwards for a guard. Be conservative about
   banking a win, be liberal about catching damage — that asymmetry is
   intentional.
2. **The score clears `1 - min_effect_pct/100`** (default 1%, so `score <
   0.99`). A sub-1% shave is discarded by design as `improvement_below_min_effect`
   even when it is real: not worth a commit in an unattended loop.
3. **At least one benchmark improved past a Bonferroni-corrected significance
   bar**, `alpha / k` where `k` is the number of benchmarks compared.
   Comparing several benchmarks against the same uncorrected `alpha` inflates
   the chance that at least one shows a spurious "significant" improvement
   even when nothing changed — that is what the correction is for.

## Releasing

Publishing runs from GitHub Actions with npm **trusted publishing** (OIDC).
There is no npm token in this repository, in its secrets, or on any
maintainer's machine: npm mints a short-lived credential from GitHub's own
identity for that one workflow run, and attaches a provenance attestation
linking the published tarball to the commit and run that built it.

To cut a release:

```bash
npm version patch    # or minor / major — commits and tags
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which refuses to publish if
the tag and `package.json` disagree, and runs the full suite on Linux first.

Two things to know if you are wiring this up on a fork or a new package:

- The trusted publisher on npmjs.com names the **workflow filename**, so
  renaming `release.yml` breaks publishing until the setting is updated.
- npm cannot publish a package's **first** version this way — a trusted
  publisher can only be configured on a package that already exists
  ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). That one publish
  needs a token; every release after it is token-free.

## Platform support

| | |
|---|---|
| **Linux** | supported — CI runs the full suite on Node 20 and 22 |
| **macOS** | supported — CI runs the full suite on Node 20 and 22 |
| **Windows** | **not supported** |

On Windows 448 of 458 tests pass, so measurement itself works. What does not
work is stopping: Node cannot deliver SIGINT to a child process group there
the way it does on POSIX, so an interrupted `eval` never reaches the `ABORTED`
path — it exits with a null code instead of 2 and can leave its claim behind.
An unattended harness that cannot be reliably stopped is not something to be
quiet about, so `doctor` says so on Windows rather than letting you find out
at 3am. Two further failures are the test suite's own POSIX assumptions
(a `chmod`-unreadable directory, and path separators) rather than product bugs.

WSL reports as Linux and is unaffected. Node 20 or newer is required
everywhere.

## Limitations

Stated here rather than left for you to discover:

- **A `KEEP` is evidence, not proof.** Any significance threshold admits
  false positives by construction — `alpha = 0.05` means a true no-op change
  still looks "significant" one time in twenty, by design, however the
  harness is implemented.
- **Laptops are noisy.** Background processes, thermal throttling, and on
  Apple Silicon specifically, the scheduler moving work between performance
  and efficiency cores, all show up as measurement noise, not signal.
  `doctor` reports load, power source and thermal state and warns when they
  look bad — it cannot fix any of them. If experiments look erratic on a
  laptop, raise `min_effect_pct` or measure on a quiet machine instead.
- **No benchmarks, no value.** `init` refuses outright on a repository with
  no `*.bench.*` file, rather than accepting a config with nothing to gate
  on and pretending a verdict means something.
- **A small measurement asymmetry survives within a round.** Rounds
  alternate which side runs first, cancelling drift *between* rounds, but
  within a single round one side always runs first and the other second —
  any bias monotonic across just that round (a CPU still ramping up, a
  background job starting mid-measurement) lands on whichever side ran
  second. Averaging over rounds does not remove this, because it is a
  constant offset, not noise; that's why round counts are kept even.
- **Microbenchmarks are not your application.** A `bench()` that measures a
  cold path or a trivial helper produces numbers that are entirely real and
  entirely useless. Benchmark what actually dominates your workload.
- **`count` below 4 can never reach significance**, whatever the size of the
  improvement — with 2 or 3 rounds per side the best achievable two-sided
  p-value (0.333 or 0.1) is already above the default `alpha`. `config`
  refuses a `count` under 4 rather than silently running a harness that can
  never `KEEP`.
- **`bytes/op` is an approximate hint, never scored.** V8 exposes no
  allocation counter, so it is a heap-size delta measured across a
  forced-GC window — noisy by construction, since it can only see whatever
  the GC left uncollected at the sampling point, not what was actually
  allocated. It can also be entirely absent: the driver child needs
  `--expose-gc`, and a bench file that fails to import or throws while
  running is dropped from the hint rather than measured. Either way it is
  silently omitted from the eval output rather than failing the run — a
  hint that couldn't be measured must never fail a real, correctly-measured
  experiment. It exists to point at allocation-heavy code, nothing more.
- **There is no `benchtime` setting.** Coming from the Go tool, you will
  look for one. Vitest exposes no global "run this benchmark for N seconds"
  option, so per-benchmark duration lives in the `bench()` call itself (via
  Vitest's own `time`/`iterations` options in the bench file), not in
  `.autor3search/config.yaml`. `count` controls how many measured rounds
  the harness runs, not how long any one of them takes.
- **This harness is not a compiled binary.** The Go original leans partly on
  being one: the agent it constrains cannot edit the tool measuring it,
  because it isn't source the agent can reach. This harness is an
  npm-installed JavaScript program, running as the same OS user as the
  agent it's grading — so an agent that decided to, could in principle edit
  this package's own installed files. Out-of-tree state (the frozen copies,
  the baseline record, the pinned worktree, all living under the user
  cache rather than the repository), together with rejecting dependency
  files and known Vitest/Vite config filenames outright, protects the
  metric from *most* of what the agent could do inside the repository being
  optimized: editing its own tests or benchmarks, weakening the config that
  constrains it, or redirecting the bench runner's import through a config
  file. It does not close every such route — only the config filenames
  Vitest 2.1.9 is known to load at the repository root are rejected, so a
  bench runner reconfigured to load from somewhere else, a workspace-globbed
  config in a subdirectory, or some other toolchain file this project has
  not enumerated could still retarget what gets measured. This is a
  genuinely weaker guarantee than the Go tool's, and it is stated here
  rather than left for you to find out the hard way.
- **A narrow TOCTOU window exists in the freeze module.** `src/freeze.js`
  checks that a frozen path (and every directory on the way to it) is not a
  symlink or hard link, then reads or writes it. Between that check and the
  write, an agent racing the harness in the same process tree could in
  principle swap the path. This is theoretical under this project's threat
  model — an unattended overnight agent isn't racing filesystem syscalls
  against itself — but it is real, not closed by design, and is disclosed
  here rather than implied away.

## Repos with no benchmarks

`autor3search-javascript init` refuses to write a config for a repository
with no `*.bench.*` file:

```
no benchmarks found in <repo>.

autor3search-javascript optimizes what it can measure, and refuses to guess. Write at least one
Vitest benchmark covering the code you want made faster, in a *.bench.js file:

    import { bench } from 'vitest'
    import { thing } from './thing.js'

    bench('thing', () => { thing() })

Benchmark the path that actually dominates your workload — one that exercises a cold path or a
trivial helper produces numbers that are entirely real and entirely useless. Then run init again.
```

Write a `bench()` around the function that shows up at the top of a real
profile of your application, not around whatever is easiest to isolate. Once
`init` finds at least one, it discovers it by *parsing* the file (via
`@babel/parser`), not by running it — so this works even on a tree that does
not currently build, which matters because that is also when a candidate
most needs to fail loudly rather than be silently skipped.

## License

MIT © 2026 Gal Be
