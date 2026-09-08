# program.md

This file is your instructions, coding agent. Read it fully before doing
anything. It is the only thing a human edits to steer this run — everything
else (the metric, the gates, the verdict) belongs to the harness.

## Setup

Before starting the loop, do this once:

1. Agree a run tag with the human if one was not already given (a short slug
   like `sep7` — today's date or similar is fine).
2. Confirm `autor3search-javascript baseline -tag <tag>` has already been run
   for this tag. If it has not, stop and ask the human to run it, or run it
   yourself if you have been told you may. `baseline` creates the run branch,
   freezes the current test AND benchmark files as golden copies, and records
   the commit this run measures against. Everything downstream depends on this
   having happened exactly once.
3. Read the repository. Skim the files matched by `scope` in
   `.autor3search/config.yaml`. Run `autor3search-javascript profile` once so
   you know what you are starting from before changing anything.

## Experimentation

What you MAY do:

- Edit any source file matched by a `scope` pattern in
  `.autor3search/config.yaml`.
- Add new files inside `scope`, as long as they are not test or benchmark
  files.
- Run any read-only diagnostic (`autor3search-javascript profile`,
  `node --cpu-prof`, reading `run.log`) as often as you like between
  experiments.

What you MUST NOT do:

- **Edit any `*.test.*`, `*.spec.*` or `*.bench.*` file.** All of them are
  restored from the frozen baseline copies before every `eval`, so an edit
  there is silently discarded and wastes an experiment slot. The benchmark
  files matter as much as the tests: they define the metric. If a test looks
  wrong, say so in your `-desc` and move on; do not try to route around it.
- **Edit `package.json` or any lockfile, ever.** These are rejected outright
  regardless of `scope`. Changing a dependency is a supply-chain decision a
  human makes, and a swapped dependency changes *what* is measured, not just
  how fast it runs.
- **Edit `.autor3search/config.yaml`.** Its hash is recorded at `baseline`
  time; if it has changed by `eval` time the run fails with reason
  `config_changed`.
- Edit an ordinary source file outside `scope`. That is what the scope gate
  rejects, failing the experiment before it is even measured.
- Try to weaken, disable or reinterpret the verdict. `eval`'s exit code and
  `--json` output are the only truth.
- Batch multiple unrelated changes into one experiment. One idea per
  experiment keeps every result attributable and every discard cheap.

## Output format

`autor3search-javascript eval` is the only command whose result decides
anything. It exits with one of four codes:

| Exit code | Meaning | Verdict status |
|---|---|---|
| `0` | KEEP — a real, safe improvement | `KEEP` |
| `1` | DISCARD — no significant improvement, too small to bank, or a regression | `DISCARD` |
| `2` | FAIL — a gate rejected the change: scope, config, tampering with a frozen file, a new or missing test/bench file, lint, or a failing test | `FAIL` |
| `3` | CRASH — the typecheck failed outright, a phase timed out, or the benchmark measurement itself failed | `CRASH` |

Any status the harness cannot classify arrives as exit code `2`. `ABORTED`
(see "Stopping") does too, for exactly that reason: it is not a verdict, and
treating it like FAIL is the right thing to do with it.

**A `KEEP` requires a real, not just a technically significant, improvement.**
`eval` returns `KEEP` only when `score` clears `1 - min_effect_pct/100`
(default 1%, i.e. score < 0.99) AND at least one benchmark improved past a
Bonferroni-corrected significance bar. A change that shaves off a fraction of
a percent is `DISCARD`ed by design — do not spend a night chasing sub-1% wins.
And even a `KEEP` is evidence, not proof: any significance threshold admits
some false positives.

With `--json`, `eval` prints one JSON object to stdout and nothing else:

```json
{
  "status": "KEEP",
  "reason": "improved",
  "score": 0.9123,
  "message": "score 0.9123 (-8.77%)",
  "regressions": [],
  "warnings": [],
  "stop_requested": false,
  "run": {
    "tag": "sep7",
    "branch": "autor3search-javascript/sep7",
    "baseline_commit": "a3f1c2d",
    "measure_commit": "9b7e410",
    "worktree": "/Users/you/Library/Caches/autor3search-javascript/1a2b3c4d/sep7/baseline-worktree",
    "experiment": 5
  }
}
```

`reason` is a stable machine-readable code: `improved`,
`no_significant_improvement`, `improvement_below_min_effect`,
`guard_regression`, `scope_violation`, `config_changed`, `new_test_file`,
`missing_test_file`, `symlink_swap`, `hardlink_swap`, `frozen_store_tampered`,
`baseline_tampered`, `typecheck_failed`, `lint_failed`, `tests_failed`,
`measurement_failed`, `timeout`, `stop_forced`.

Two discard reasons mean genuinely different things.
`no_significant_improvement` means nothing measurably moved — the idea did not
work, drop it. `improvement_below_min_effect` means it DID work and the
harness measured a real speedup, just smaller than `min_effect_pct` will bank.
That says the direction is right: a variation with a larger effect, or the
same idea applied to a hotter path, may well clear the bar. Do not read it as
failure.

`score` is the geometric mean of `candidate_time / baseline_time` across the
declared benchmarks — below 1 is faster.

`warnings`, when present, says the measurement is too weak to carry the
verdict printed beside it. They never change the decision; they tell you not
to over-read it. Two you may see:

- **too few observations for a confidence interval** — the medians are real
  but the interval around them is unbounded. Raise `count`.
- **no KEEP was reachable** — the significance threshold is corrected for the
  number of benchmarks compared (`alpha/k`), and with the configured `count`
  the test cannot produce a p-value that small however large the improvement
  is. Every experiment will `DISCARD` until `count` is raised. Treat this as a
  broken configuration and stop rather than burning the night on experiments
  that cannot be banked.

**What the baseline means changes as the run progresses.** It is NOT always
the commit `baseline` recorded — it is whatever the measurement baseline
currently points to, and a KEEP moves that pointer to the commit you just
kept. So `score` always answers "did THIS experiment help, compared to the
last thing that was kept" — never "is the tree better than when the run
started." Two consequences: after a KEEP, running `eval` again with nothing
new committed measures your last commit against itself and correctly
`DISCARD`s — that is not a bug; and a long run's total progress is the
*product* of every kept `score`, which is what `report` computes.

`stop_requested` is the one field that changes what you do. See below.

## Stopping

The loop does not end on its own. It ends in one of two ways.

**A graceful stop.** The human runs `autor3search-javascript stop`. That
writes a request `eval` reports back as `"stop_requested": true`, alongside a
verdict that is still fully valid. When you see it:

1. Apply the verdict exactly as you would have anyway — KEEP leaves the
   commit, anything else is `git reset --hard HEAD~1`. A stop must never leave
   a commit on the branch that nothing decided on.
2. Do NOT start another experiment.
3. Run `autor3search-javascript report` and summarize in a few lines: what you
   tried, what was kept, what you would try next.
4. Exit the loop and say you stopped because the human asked.

**An interrupt.** Ctrl+C, or `autor3search-javascript stop --force`. Either
cancels `eval` mid-experiment. You will see `"status": "ABORTED"` with
`"reason": "stop_forced"`, exit code `2`, and no `results.tsv` row — nothing
was measured, so nothing was recorded. Treat the commit as you would any FAIL
(`git reset --hard HEAD~1`), then stop as above.

If the human wants the run to continue after all, they clear the request with
`autor3search-javascript stop --clear`. That is their decision, not something
to wait for or ask about.

## Logging

`results.tsv` is HARNESS-OWNED. `eval` appends exactly one row on every
invocation, KEEP or not. Never create, append to, or edit it yourself — a
manual write is either redundant or corrupts a file the harness parses
strictly, breaking the human's morning `report` on the whole file.

The one column that is yours is `description`, set with `-desc`:

```
autor3search-javascript eval --json -desc "preallocate the map"
```

Always pass `-desc`, on every invocation, KEEP or not — it is the only record
of what you were trying. Keep it terse and never dishonest: describe what you
actually tried, including for a DISCARD, FAIL or CRASH. A long trail of honest
discards is more useful to the human than a short trail that hides them.

## JavaScript optimization idea bank

Measure first, then reach for these:

- **Ask whether the work is needed at all.** An algorithmic change, or
  skipping work entirely, usually beats every micro-optimization below.
- **Allocation in hot loops.** Every intermediate array, object literal and
  closure allocates. `autor3search-javascript profile` reports an approximate
  `bytes/op` alongside the timings.
- **Avoid intermediate arrays.** `arr.map(f).filter(g).reduce(h)` walks the
  data three times and allocates twice. One loop does not.
- **Keep object shapes stable.** Assigning properties in a consistent order,
  and never deleting them, keeps V8 on a monomorphic hidden class. A
  polymorphic call site is far slower than a monomorphic one.
- **Preallocate.** `new Array(n)` when n is known, and typed arrays
  (`Float64Array`, `Uint8Array`) for numeric data — they avoid boxing entirely.
- **Hoist closures out of loops.** A function expression created inside a loop
  allocates on every iteration.
- **String building.** Repeated `+=` in a long loop can be quadratic; collect
  into an array and `join('')`, or build with a fixed-size buffer.
- **`Map` vs plain object vs array.** For small fixed key sets a linear scan
  over an array beats both. `Map` beats an object for frequent insertion and
  deletion of non-identifier keys. Measure at your real size.
- **Avoid `try`/`catch` and `arguments` in the hottest function** if it stops
  V8 optimizing it — check with `--trace-deopt` before assuming.
- **Regular expressions.** Compile once outside the loop; a `RegExp` literal
  inside a loop with the `g` flag also carries mutable `lastIndex` state.
- **Character codes over string methods.** `charCodeAt` and numeric comparison
  avoid the allocation `toLowerCase()` on a single character causes.

## The experiment loop

`eval` splits its own output for you: the verdict — one compact JSON object —
goes to stdout, and the full build/lint/test/benchmark transcript goes to
`run.log` in the repository root. `run.log` is the harness's own file, opened
by `eval` before it does anything else. **Never redirect `eval`'s stdout into
it** (`eval --json > run.log 2>&1` or similar): that opens a second descriptor
on a path the harness already holds open, and whichever writes second
overwrites the other from byte 0 — destroying exactly the transcript you need
when something FAILs or CRASHes. Run `eval --json` bare and read the verdict
from its stdout; open `run.log` only to read.

LOOP FOREVER:

0. Print one context line so the human watching knows where the run is:
   `[exp <n> | <branch> | vs <measure_commit> | stop: autor3search-javascript stop]`
   Take the numbers from the previous experiment's `run` object; on the first
   pass, from `autor3search-javascript status`.
1. Confirm you are on the run branch.
2. If you have no strong hypothesis, run `autor3search-javascript profile` and
   read the hot spots.
3. Change ONE thing in the in-scope source. One idea per experiment.
4. `git add -A && git commit -m "<idea>"`
5. `autor3search-javascript eval --json -desc "<idea>"` — no redirect.
6. Read the verdict from stdout: one compact JSON object.
7. KEEP → leave the commit; the branch advances and the measurement baseline
   advances to this commit, so your next experiment is measured against what
   you just kept.
   Anything else → `git reset --hard HEAD~1`
8. If the verdict carried `"stop_requested": true`, or its status was
   `ABORTED`, follow "Stopping" and leave the loop.
9. Go to 0.

**NEVER STOP ON YOUR OWN.** Do not pause to ask whether to continue. The human
may be asleep. You are autonomous. If you run out of ideas, re-read the
profile output, re-read the idea bank, combine previous near-misses, or try a
more radical change.

Only the human ends this loop, and only in the two ways "Stopping" describes.
Running out of ideas is not one of them, and neither is a long string of
DISCARDs.
