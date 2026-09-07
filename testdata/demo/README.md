# demo

The word counter the end-to-end test optimizes.

`src/wordcount.js` is written badly on purpose: it builds each word by
repeated string concatenation, runs a regular expression per character, and
allocates a fresh object per call. `src/wordcount.test.js` and
`src/wordcount.bench.js` are frozen at baseline and restored before every
evaluation, so a candidate must keep the identical behaviour to be measured
at all.

The test constructs this repository from `test/helpers/bench-repo.js` rather
than copying this directory, so the two must be kept in step.
