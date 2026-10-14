import path from 'path'
import { run } from './run'
import { unwrapScriptPath } from '../paths'
import { findPython } from '../python'

/**
 * Turn a decrypted SELF container into a clean ELF using AnyPS5's unwrap_self.py.
 * `output` may equal `input` to unwrap in place.
 */
export async function unwrapSelf(input: string, output: string, verbose = false): Promise<void> {
  const python = await findPython()
  if (!python) {
    throw new Error(
      'Python 3 was not found on this system. Install Python 3 (python.org) so the SELF unwrap step can run.'
    )
  }

  const [cmd, ...prefix] = python.split(' ').filter(Boolean)
  const args = [...prefix, unwrapScriptPath(), input, output]
  if (verbose) args.push('--verbose')

  const { code, stdout, stderr } = await run(cmd, args, { timeoutMs: 10 * 60 * 1000 })

  if (code !== 0) {
    const detail =
      /not a SELF container/i.test(stderr)
        ? `${path.basename(input)} is not a SELF container.`
        : /looks encrypted/i.test(stderr)
          ? `${path.basename(input)} is still encrypted — dump it decrypted before converting.`
          : (stderr.trim() || stdout.trim() || `exit code ${code}`)
    throw new Error(`Unwrap failed — ${detail}`)
  }
}
