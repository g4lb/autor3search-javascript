# autor3search-javascript — design

**Date:** 2026-09-07
**Status:** approved, ready for implementation planning
**Ported from:** [`autor3search-go`](https://github.com/g4lb/autor3search-go)

## 1. What this is

A frozen measurement harness that lets an AI coding agent autonomously optimize a
JavaScript/TypeScript repository. The agent proposes one performance change per
experiment; the harness gates correctness, measures the candidate against a pinned
baseline, and returns `KEEP` / `DISCARD` / `FAIL` / `CRASH`. The agent cannot reach
the metric.

This is a port of `autor3search-go`, not a reimagining. Every invariant that decides
a verdict is carried across deliberately and verbatim where the language permits.
Divergences are enumerated in §8 and each one has a stated reason.

### Why a port at all

The Go harness's value is not its Go-ness. It is the discipline: frozen tests,
out-of-tree state, interleaved A/B measurement, an honest significance test, and a
single scalar the agent cannot argue with. All of that is language-agnostic. What is
not portable is the measurement substrate — Go ships one universal benchmark format
and one tool that emits it; JavaScript ships neither. §3 is where that gap is closed.

## 2. Naming and shipping

| Thing | Value |
|---|---|
| npm package | `autor3search-javascript` |
| binary / `bin` entry | `autor3search-javascript` |
| run branch | `autor3search-javascript/<tag>` |
| state home override | `AUTOR3SEARCH_JAVASCRIPT_STATE_HOME` |
| state dir name (under user cache) | `autor3search-javascript` |
| in-repo config | `.autor3search/config.yaml` |
| in-repo agent instructions | `program.md` |
| in-repo experiment log | `results.tsv` |
| in-repo subprocess transcript | `run.log` |
| license | MIT © 2026 Gal Be |

Written in **plain JavaScript, ESM, no build step**. `bin/autor3search-javascript.js`
runs directly from source under Node ≥ 20. Types are documented with JSDoc; there is
no compiler.

Dependencies, kept deliberately few because the harness is the thing being trusted:

- `yaml` — config parsing
- `@babel/parser` — benchmark/test discovery (parses TS and JSX without typechecking,
  so discovery still works on a tree that does not build, matching `go/ast`'s role)
- `picomatch` — scope glob matching

Everything else is Node builtins. The statistics are hand-ported (§4). Vitest is the
*target repository's* dependency, never ours.

## 3. Measurement substrate

### 3.1 The benchmark runner

Benchmarks are **Vitest `bench()`** tasks in `*.bench.{js,mjs,cjs,jsx,ts,mts,cts,tsx}`
files. One measured round is one `vitest bench --reporter=json` invocation, filtered
to the declared benchmark set with `--testNamePattern`.

This sits behind a `BenchRunner` adapter interface so a second runner can be added
without touching `measure`, `bench/stats`, `verdict` or `pipeline`:

```js
// src/adapters/bench/index.js
/**
 * @typedef {object} BenchRunner
 * @property {(root: string) => Promise<Benchmark[]>} discover
 * @property {(dir: string, opts: RunOpts) => Promise<Set>} run
 */
```

`src/adapters/bench/vitest.js` is the only implementation in this version.

The adapter **validates the reporter's JSON shape at runtime** and fails loudly with
the offending payload when it does not match. A silently-changed reporter format that
yields zero benchmarks would otherwise present as "no benchmarks matched", which reads
like a user error and is not one. Parsing is covered by fixture tests captured from a
real Vitest run.

### 3.2 One observation per round — the critical statistical decision

Tinybench (inside Vitest) reports a `samples[]` array of per-iteration timings for
each task. **These are not fed to the significance test.** Each round contributes
exactly **one** observation per benchmark: the **median of that round's samples**.

This is the single most likely way a naive port gets the statistics wrong. The unit of
independent variation here is the *process invocation* — a cold JIT, a fresh heap, the
machine's state at that moment. Per-iteration samples within one invocation are
strongly correlated; pouring 500 of them per side into a Mann-Whitney test would
inflate `n` by two orders of magnitude and return a vanishing p-value for
differences that are pure within-process noise. Every experiment would read as
significant, and the harness's entire reason for existing would be gone.

So: `count` rounds per side, one number per round, exactly as `go test -bench -count=1`
run `count` times produced for the Go version.

### 3.3 Interleaving

Unchanged from Go, and it matters *more* here. `measure.interleave()` alternates
baseline and candidate round by round **and swaps their order within each round**
(base,cand then cand,base), with one leading warmup round discarded. Alternating
rounds cancels drift between rounds; swapping within the round cancels the systematic
offset from one side always being measured a moment later than the other. An even
`count` cancels that offset exactly; an odd one leaves a round's worth behind.

JavaScript adds two drift sources Go does not have — JIT tier-up and GC scheduling —
which the discarded warmup round and the interleaving absorb.

### 3.4 Units

| Unit | Scored? | Source |
|---|---|---|
| `sec/op` | **yes — the only scored unit** | Vitest bench, median of round samples |
| `bytes/op` | no, hint only, labelled approximate | heap-delta pass (§3.5) |

The `Measurements` boundary from the Go version is preserved verbatim: `verdict.decide()`
only ever sees the time deltas. A future change that starts scoring `bytes/op` would
silently let allocation-only changes with no latency improvement pass as KEEP.

### 3.5 The heap-delta hint

Go reported exact `allocs/op` and `B/op` from the runtime. V8 has no equivalent
counter, so the substitute is measured, not free:

`src/adapters/driver.js` is a standalone bench-file driver. It imports a `*.bench.*`
module with a stub `bench()`/`describe()` registration shim, then for each registered
task runs it a fixed number of iterations inside a child Node process started with
`--expose-gc`, forcing a collection before and after the window and recording
`(heapUsed_after − heapUsed_before) / iterations`.

One heap pass runs per side per round, so `bytes/op` gets the same `n` as timing and
therefore a real p-value — but it is **noisy**, because GC timing is not under our
control. It is reported to the agent and written to `results.tsv` as a hint, is
labelled approximate in every surface that prints it, is never scored, and can never
trip the regression guard.

**If the heap pass fails for any reason, the experiment proceeds without the hint.**
This mirrors the Go pipeline's handling of an unavailable `allocs/op` comparison: a
missing hint is never a reason to discard an otherwise-valid experiment.

The same driver backs `profile` (§6.4), so the shim is written once.

## 4. Statistics — porting `benchmath`

`golang.org/x/perf/benchmath` has no JavaScript equivalent. `src/bench/stats.js` ports
the subset the harness uses. This module is the verdict, so it gets the densest tests
in the project, including golden values checked against the Go implementation.

**`summary(values, confidence)` — the `AssumeNothing` estimator.**
Center is the **median**. The confidence interval is distribution-free, from order
statistics under the binomial distribution. At 95% confidence fewer than 6
observations per side cannot produce a bounded interval; that emits a warning rather
than a fabricated interval.

**`compare(base, cand)` — two-sided Mann-Whitney U.**
Exact enumeration (DP over the U distribution) when both samples are small and
untied — which covers the default `count: 10` per side, where `C(20,10) = 184,756`
orderings are enumerated directly. Normal approximation with tie correction otherwise.
Returns `{p, alpha, n1, n2, warnings}` with `alpha = 0.05`.

**`minAchievableP(n1, n2) = 2 / C(n1+n2, n1)`** — the p-value floor for a given sample
size. Reproduces benchmath's generated table exactly (0.3333 at n=2, 0.1000 at 3,
0.02857 at 4, 0.00794 at 5) without duplicating it.

**`geoMean(deltas)`** — computed in log space, as in Go.

**`compareAll(base, cand, unit)`** — strict: a benchmark measured at baseline but
missing from the candidate is an error, because a benchmark that disappears cannot be
checked for regressions.

Warnings from benchmath are carried out of this module rather than swallowed,
deduplicated across the two summaries and the comparison, exactly as Go does. The
warning *wording* is ours; the conditions that raise them are benchmath's.

## 5. Scoring and the verdict

Ported unchanged from `internal/verdict`. Stated here because it is the product.

```
score = geomean(cand_sec / base_sec)   across the declared benchmark set
```

`KEEP` requires **all** of:

1. **Minimum real effect.** `score < 1 − min_effect_pct/100` (default 1%, so
   `score < 0.99`), not merely `score < 1`.
2. **A Bonferroni-corrected significant improvement.** At least one benchmark
   improved with `p < alpha/k`, where `k` is the number of benchmarks compared in
   this experiment.
3. **No significant regression beyond `max_regress_pct`** (default 5%). This guard
   uses the **raw, uncorrected** alpha, deliberately. Bonferroni only ever makes
   significance harder to reach; applying it here would make real regressions easier
   to miss. Be conservative about accepting a win, liberal about catching damage.

`Delta.significant` always means "significant at the raw alpha" — that stays the
honest statistic a human reads. The correction in rule 2 is a KEEP threshold layered
on top, not a redefinition of "significant".

Discard reasons distinguish the two ways rules 1 and 2 fail:
`no_significant_improvement` (nothing moved) versus `improvement_below_min_effect`
(it really did work, by less than the floor). The difference changes what the agent
tries next, so it must not be collapsed.

**Warnings that never change the decision** but qualify it: too few rounds for a
bounded confidence interval, and *no KEEP was reachable* — when `alpha/k` falls below
the U test's p-value floor for every benchmark, so the run cannot bank anything no
matter what the agent does. The second names the `count` to raise to.

Statuses, reasons and exit codes are identical to the Go version:

| Exit | Status | Meaning |
|---|---|---|
| 0 | `KEEP` | real, safe improvement |
| 1 | `DISCARD` | no significant improvement, or below the effect floor, or regression guard |
| 2 | `FAIL` | a gate rejected it (scope, config hash, test-set integrity, lint, tests) — also `ABORTED` |
| 3 | `CRASH` | build/typecheck failed outright, or a phase timed out |

## 6. Commands

All nine, all accepting `-C <dir>` to operate on a repository other than the current
directory without changing the process working directory.

### 6.1 `init`

Scans the repository, discovers benchmarks, and writes three things — without
committing any of them:

1. `.gitignore` entries: `results.tsv`, `run.log`, `.autor3search/*`,
   `!.autor3search/config.yaml`
2. `.autor3search/config.yaml`
3. `program.md`

Refuses to overwrite an existing config without `-force`.

**Refuses outright when no benchmark is found**, exactly as Go does, and says why: the
harness has no other notion of "faster", so an empty benchmark set would mean every
candidate is accepted or rejected for no reason. The error explains how to add a
Vitest `bench()` and re-run.

### 6.2 `doctor`

Informational, always exits 0. Checks:

- `node` on PATH, version ≥ 20
- `git` on PATH; the directory is a git repository
- CPU count; load average (`os.loadavg()`)
- **macOS:** on battery (`pmset -g batt`), Low Power Mode, thermal pressure
  (`sysctl machdep.xcpm.cpu_thermal_level`)
- **Linux:** cpufreq governor, `intel_pstate/no_turbo`, thermal throttling
- Free disk space (`fs.statfs`)
- **New for JS:** Vitest resolvable in the target repo; `--expose-gc` usable (so
  `doctor` can say up front that the heap hint will be unavailable, rather than
  letting it fail silently mid-run)

### 6.3 `baseline -tag <tag>`

Refuses a dirty tree and a reused tag. Creates the run branch
`autor3search-javascript/<tag>`, freezes the test **and benchmark** files (§8.2),
records the baseline, and pins a detached worktree at the baseline commit.

`-force` discards an existing `results.tsv` that already holds rows.

### 6.4 `profile`

Runs the declared benchmarks under Node's `--cpu-prof` and `--heap-prof` via the §3.5
driver, writes `.autor3search/profiles/<bench-file>/{cpu.cpuprofile,heap.heapprofile}`,
and prints a top-by-self-time table parsed from the `.cpuprofile` JSON directly — no
`pprof` equivalent needed. Output notes the files are openable in Chrome DevTools or
speedscope.

### 6.5 `eval`

The only command whose result decides anything. Flags: `-C`, `--json`, `-desc`,
`--no-log`. Runs one experiment:

1. **Scope gate.** Diffs against the **frozen** `commit` (never the advancing
   `measure_commit`), so the *full accumulated* diff is re-validated on every eval and
   an out-of-scope edit cannot be laundered into "already accepted" state by one pass.
   `package.json` and any lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
   `bun.lock`, `bun.lockb`) are rejected regardless of scope.
2. **Config integrity.** `.autor3search/config.yaml` is hashed at baseline; any change
   fails with `config_changed`.
3. **Restore frozen files.** Agent edits to tests and benchmarks are erased, not
   argued with. Symlink swaps anywhere along a frozen path, and a tampered frozen
   store, each produce a distinct FAIL reason.
4. **Frozen-set integrity, both directions.** A test or bench file present but not
   frozen is `new_test_file`; a frozen file no longer reachable by the walker is
   `missing_test_file`.
5. **Typecheck gate** (`tsc --noEmit` if a tsconfig exists, else a parse of every
   in-scope file) → CRASH on failure.
6. **Lint gate** (ESLint if configured) → FAIL on failure.
7. **Test gate** (`vitest run`) → FAIL on failure, CRASH on timeout.
8. **Baseline worktree integrity.** The pinned worktree's HEAD must still equal
   `measure_commit`. Carried across with Go's honest caveat: this is a detection of
   accidental clobbering and careless tampering, not an airtight guarantee against a
   same-user attacker.
9. **Measure**, interleaved (§3.3).
10. **Score and decide** (§5).
11. **On KEEP, advance the measurement baseline**: re-point the pinned worktree and
    persist the candidate's commit as the new `measure_commit`.
12. Append exactly one `results.tsv` row.

`--json` prints one JSON object to stdout and nothing else. Subprocess transcripts go
to `run.log`, opened by `eval` itself.

### 6.6 `status`

Read-only, works from any branch, accepts `-tag`. Prints run tag, branch and whether
it is checked out, frozen baseline commit, advancing measurement commit, pinned
worktree path, experiment counts by verdict, whether an eval is in flight, and whether
a stop is pending. Checking on a run must never change it.

### 6.7 `stop`

`stop` writes a request `eval` reports back as `"stop_requested": true` — the agent
finishes and scores the current experiment, applies the verdict, then leaves the loop.
`-clear` cancels a pending request. `-force` additionally signals the running eval to
abandon the current experiment (§8.6) and reports what state that leaves the
repository in, without changing anything itself.

### 6.8 `report`

Summarizes `results.tsv`: counts by status, cumulative speedup as the **product** of
every kept score, and the largest individual wins.

### 6.9 `version`

Prints the package version, and — when running from a git checkout — the commit, with
a `dirty` marker when the tree had uncommitted changes. A `results.tsv` row is only as
reproducible as the harness that produced it.

## 7. Configuration

```yaml
# .autor3search/config.yaml
benchmarks: []            # declared set; empty = every discovered benchmark
scope: ["**"]             # glob patterns the agent may edit
count: 10                 # measured rounds per side
benchtime: 1s             # per-round bench duration
max_regress_pct: 5.0
min_effect_pct: 1.0
timeout: 15m              # bounds each subprocess phase
unfreeze: []              # test/bench files deliberately exempt from freezing
runner: vitest
heap_hint: true
gates:
  typecheck: auto         # auto | on | off
  lint: auto
  test: auto
```

Validation, ported with its reasoning intact:

- **`count >= 4`.** Below that the Mann-Whitney test cannot report `p < 0.05` however
  large the improvement, so every experiment would discard on a technicality. The
  error says so rather than failing silently.
- `benchtime` must be a duration. It maps to Vitest's per-task benchmark `time` budget,
  converted to milliseconds by the adapter. The fixed-iteration-count form (`100x`) is rejected
  with an explanation, because a fixed count makes rounds incomparable — a candidate
  twice as fast finishes in half the wall time and is measured under different thermal
  conditions, which is exactly what the interleaved design exists to eliminate.
- `max_regress_pct >= 0`; `0 <= min_effect_pct < 100`
- `scope` non-empty, no blank or whitespace-only entries
- `timeout` must be a duration
- `gates.*` must be one of `auto` / `on` / `off`
- `runner` must name a registered `BenchRunner` adapter; `vitest` is the only one in
  this version, and an unknown value is an error rather than a silent fallback
- `heap_hint` must be a boolean; `false` disables the §3.5 pass entirely, so the
  `bytes/op` column is absent rather than empty

`src/duration.js` provides Go-style duration parsing (`500ms`, `1s`, `15m`).

## 8. Deliberate divergences from the Go version

Each of these is a decision, not an oversight.

### 8.1 `race` and `gomaxprocs` are dropped
Single-threaded JS has no race detector, and there is no meaningful `GOMAXPROCS`
analogue. Faking either would be worse than its absence. `count`'s role in cancelling
noise is unchanged.

### 8.2 The frozen set covers `*.bench.*` as well as test files
**The most important adaptation.** In Go the benchmark *is* a function in a `_test.go`
file, so freezing tests froze the metric. In JavaScript the benchmark lives in its own
file. Freezing only tests would leave the metric itself agent-writable — the agent
could rewrite the benchmark to measure something easier and every gate would pass.
Both file classes are snapshotted at baseline and restored before every eval.

### 8.3 Dependency guard covers `package.json` and lockfiles
The direct analogue of Go's `go.mod`/`go.sum` rule. Rejected regardless of scope: a
dependency swap is a supply-chain decision a human makes, and it changes *what* is
measured rather than how fast it runs.

### 8.4 Scope patterns are globs
`src/**`, `lib/**/*.js`, default `["**"]`, matched with `picomatch`. Go's `./...`
directory-prefix form is unidiomatic in JavaScript and strictly less expressive. Go's
explicit rejections are kept: an absolute path, or one that climbs out of the
repository root with `..`, is never in scope no matter what the patterns say.

### 8.5 `allocs/op` → approximate `bytes/op`
See §3.5. Reported as a labelled-approximate hint, never scored.

### 8.6 Process control: no `flock`, no process groups
Node has no `flock` binding and cannot `setpgid` itself.

- **Eval claim.** `src/state/lock.js` uses an atomic lock directory holding the pid
  plus a heartbeat mtime the running eval refreshes. A lock is stale when the pid is
  not alive (`process.kill(pid, 0)` → `ESRCH`) *and* the heartbeat has gone cold. Both
  conditions are required, because pids are recycled — the same hazard Go's advisory
  lock closed a different way.
- **`stop -force`.** Sends `SIGTERM` to the eval pid. Eval installs `SIGINT`/`SIGTERM`
  handlers that kill their spawned children — spawned `detached: true`, so
  `process.kill(-childPid)` takes out `vitest` and every worker it forked — then exits
  `ABORTED` (exit 2, no `results.tsv` row). This matters more than it sounds: an eval
  killed without cleanup leaves Vitest workers running, burning CPU and corrupting
  every later measurement on the machine.

### 8.7 The harness is not a compiled binary
Go leans on being a binary the agent cannot edit. An npm-installed JavaScript harness
*is* editable by an agent running as the same user. Out-of-tree state still protects
the metric from anything the agent does *inside the repository*, which is the threat
model that matters in practice — but this guarantee is genuinely weaker than Go's, and
the README will say so plainly rather than let it read as parity. Overselling a
performance tool is worse than useless.

## 9. Module map

```
bin/autor3search-javascript.js     entry point
src/
  cli/
    main.js                        subcommand registry, usage, exit codes
    cmd-{init,doctor,baseline,profile,eval,status,stop,report,version}.js
  config.js                        load + validate .autor3search/config.yaml
  duration.js                      Go-style duration parsing
  discover.js                      @babel/parser walk: bench + test files
  scope.js                         glob matcher, with ..-escape rejection
  freeze.js                        snapshot / restore / verify, symlink-hardened
  bench/
    parse.js                       Vitest JSON -> Set / Series / Metric
    stats.js                       benchmath port: median CI, Mann-Whitney, geomean
  measure.js                       interleave with per-round order swap
  verdict.js                       statuses, reasons, decide(), exit codes
  results.js                       results.tsv append / load
  state/
    index.js                       state dir, tag validation, Baseline record
    stop.js                        stop request sentinel
    lock.js                        eval claim (pid + heartbeat)
  gitx.js                          git wrappers
  runner.js                        subprocess: timeout, 4MB output cap, group kill
  pipeline.js                      one full eval: gate -> measure -> score
  doctor.js
  profile.js
  adapters/
    bench/{index.js,vitest.js}     BenchRunner interface + Vitest implementation
    driver.js                      standalone bench-file driver (heap hint, profiler)
    gates/{typecheck.js,lint.js,test.js}
templates/program.md               the agent's instruction set
test/                              Vitest, mirroring the Go test files
testdata/demo/                     word-counter fixture for the e2e
docs/superpowers/{specs,plans}/
.github/workflows/ci.yml
README.md  LICENSE  .gitignore  package.json
```

## 10. `program.md`

The agent instruction set is rewritten for JavaScript but keeps its structure and its
contract, because the loop's shape depends on the exit codes, which are unchanged.

Changes: the "may / must not" list names `*.bench.*` alongside test files as
untouchable; `go.mod`/`go.sum` becomes `package.json` and lockfiles; the JSON example
uses the new branch and state paths; and the Go optimization idea bank is replaced by
a JavaScript one — hidden-class and shape stability, avoiding megamorphic call sites,
preallocating and avoiding array reallocation, typed arrays, avoiding closure
allocation in hot loops, string building, `Map` versus object versus array at real
sizes, avoiding intermediate arrays in chained `map`/`filter`, and (first, as in Go)
asking whether the work is needed at all.

The "NEVER STOP ON YOUR OWN" discipline and the two legitimate ways a run ends are
carried across verbatim.

## 11. Testing

Vitest, dogfooding the tool's own substrate, mirroring the Go test suite file for
file. Written test-first.

- **`bench/stats.js` gets the densest coverage in the project**, including golden
  values cross-checked against the Go implementation's output. It is the verdict.
- **Adversarial freeze tests**: symlinked file, symlinked parent directory, tampered
  store, deleted frozen file, added bench file, frozen file hidden from the walker.
- **Scope tests**: absolute paths, `..` escapes, blank pattern entries.
- **Parser fixtures** captured from a real `vitest bench --reporter=json` run.
- **End-to-end**: build a temp git repo containing a deliberately slow word counter, a
  frozen test and a bench file; run `init` → `baseline` → `eval` (as a real
  improvement, a no-op, a scope violation, and a weakened test) → `report`, asserting
  the verdict, the exit code and the `results.tsv` row each time.
- Every test sets `AUTOR3SEARCH_JAVASCRIPT_STATE_HOME` to a temp directory, so the
  suite never writes to the developer's real cache.

CI runs the suite on Linux and macOS.

## 12. Out of scope for this version

- Runners other than Vitest (the adapter seam exists; no second implementation ships)
- Bun or Deno as the harness runtime
- Optimizing anything the declared benchmarks do not measure
- Any automatic remediation — the harness decides, the agent acts, and it never edits
  source itself
