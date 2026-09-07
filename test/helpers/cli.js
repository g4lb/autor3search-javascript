import { dispatch } from '../../src/cli/main.js'

/** Runs the CLI in-process, capturing both streams. */
export async function runCli(argv) {
  let out = ''
  let err = ''
  const code = await dispatch(argv, {
    out: { write: (s) => { out += s } },
    err: { write: (s) => { err += s } },
  })
  return { code, out, err }
}
