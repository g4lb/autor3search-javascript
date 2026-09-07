import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../helpers/cli.js'
import { makeRepo, writeFiles } from '../helpers/repo.js'

const HEADER = 'commit\tscore\tbest_bench_delta\tbytes_delta\tstatus\tdescription\n'

const withRows = (rows) => makeRepo({ 'results.tsv': HEADER + rows })

describe('report', () => {
  it('says plainly when no experiments have run', async () => {
    const dir = await makeRepo()
    const { code, out } = await runCli(['report', '-C', dir])
    expect(code).toBe(0)
    expect(out).toMatch(/no experiments/i)
  })

  it('says plainly when results.tsv is empty', async () => {
    const dir = await withRows('')
    const { code, out } = await runCli(['report', '-C', dir])
    expect(code).toBe(0)
    expect(out).toMatch(/no experiments/i)
  })

  it('counts experiments by status', async () => {
    const dir = await withRows('a\t0.90\t-10\t-5\tkeep\tone\nb\t1.00\t0\t0\tdiscard\ttwo\nc\t0\t0\t0\tfail\tthree\n')
    const { code, out } = await runCli(['report', '-C', dir])
    expect(code).toBe(0)
    expect(out).toMatch(/keep\s+1/)
    expect(out).toMatch(/discard\s+1/)
    expect(out).toMatch(/fail\s+1/)
    expect(out).toMatch(/total\s+3/)
  })

  it('multiplies kept scores into a cumulative speedup', async () => {
    const dir = await withRows('a\t0.5000\t-50\t0\tkeep\tone\nb\t0.5000\t-50\t0\tkeep\ttwo\n')
    const { out } = await runCli(['report', '-C', dir])
    // 0.5 * 0.5 = 0.25 -> 4.00x faster, -75%.
    expect(out).toMatch(/0\.2500/)
    expect(out).toMatch(/4\.00x/)
  })

  it('reports a compounding three-step 0.9 chain', async () => {
    const dir = await withRows('a\t0.9000\t-10\t0\tkeep\tone\nb\t0.9000\t-10\t0\tkeep\ttwo\nc\t0.9000\t-10\t0\tkeep\tthree\n')
    const { out } = await runCli(['report', '-C', dir])
    // 0.9^3 = 0.729 -> ~1.37x faster.
    expect(out).toMatch(/0\.7290/)
    expect(out).toMatch(/1\.37x/)
  })

  it('ignores non-keep scores in the cumulative product', async () => {
    const dir = await withRows('a\t0.5000\t-50\t0\tkeep\tone\nb\t0.5000\t-50\t0\tdiscard\ttwo\n')
    const { out } = await runCli(['report', '-C', dir])
    expect(out).toMatch(/2\.00x/)
  })

  it('reports a single kept experiment as its own cumulative', async () => {
    const dir = await withRows('a\t0.8000\t-20\t0\tkeep\tone\n')
    const { out } = await runCli(['report', '-C', dir])
    expect(out).toMatch(/0\.8000/)
  })

  it('lists the largest individual wins with their descriptions', async () => {
    const dir = await withRows('a\t0.90\t-10\t0\tkeep\tsmall win\nb\t0.60\t-40\t0\tkeep\tbig win\n')
    const { out } = await runCli(['report', '-C', dir])
    const bigIndex = out.indexOf('big win')
    const smallIndex = out.indexOf('small win')
    expect(bigIndex).toBeGreaterThan(-1)
    expect(bigIndex).toBeLessThan(smallIndex)
  })

  it('says nothing was kept when every experiment discarded', async () => {
    const dir = await withRows('a\t1.00\t0\t0\tdiscard\tone\n')
    const { out } = await runCli(['report', '-C', dir])
    expect(out).toMatch(/nothing was kept/i)
  })

  it('reports a malformed log with the line number rather than a stack trace', async () => {
    const dir = await makeRepo()
    await writeFiles(dir, { 'results.tsv': `${HEADER}broken line\n` })
    const { code, err } = await runCli(['report', '-C', dir])
    expect(code).not.toBe(0)
    expect(err).toMatch(/results\.tsv:2/)
    expect(err).not.toMatch(/at\s+\S+\s+\(/) // no stack-trace frame
  })

  it('does not crash on a kept score of zero', async () => {
    const dir = await withRows('a\t0.0000\t-100\t0\tkeep\tzero cost\n')
    const { code, out } = await runCli(['report', '-C', dir])
    expect(code).toBe(0)
    expect(out).not.toMatch(/Infinity/)
    expect(out).not.toMatch(/NaN/)
  })

  it('does not crash on an unrecognised status or a very long description', async () => {
    const longDesc = 'x'.repeat(5000)
    const dir = await withRows(`a\t0.9000\t-10\t0\tkeep\t${longDesc}\nb\t1.0000\t0\t0\tweird\tsomething\n`)
    const { code, out } = await runCli(['report', '-C', dir])
    expect(code).toBe(0)
    expect(out).toMatch(/total\s+2/)
    expect(out).toContain(longDesc)
  })

  it('does not let a prototype-chain status name corrupt the counters', async () => {
    // `status in counts` is true for toString/constructor/hasOwnProperty even
    // though no such counter exists — results.tsv is written by the harness
    // but read back from a file a human can edit.
    const dir = await withRows(
      'a\t0.90\t-10\t0\tkeep\treal win\n' +
        'b\t1.00\t0\t0\ttoString\tprototype name\n' +
        'c\t1.00\t0\t0\tconstructor\tprototype name\n' +
        'd\t1.00\t0\t0\t__proto__\tprototype name\n' +
        'e\t1.00\t0\t0\thasOwnProperty\tprototype name\n',
    )
    const { code, out } = await runCli(['report', '-C', dir])
    expect(code).toBe(0)
    expect(out).toMatch(/keep\s+1/)
    expect(out).toMatch(/other\s+4/)
    expect(out).toMatch(/total\s+5/)
    // The kept row's own score must be the cumulative — the four odd rows
    // must not have been counted as keeps.
    expect(out).toMatch(/0\.9000/)
  })
})
