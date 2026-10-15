import path from 'path'
import { run } from './run'
import { unwrapScriptPath } from '../paths'
import { pythonInvocation } from '../python'

/**
 * Turn a decrypted SELF container into a clean ELF using AnyPS5's unwrap_self.py.
 * `output` may equal `input` to unwrap in place.
 */
export async function unwrapSelf(input: string, output: string, verbose = false): Promise<void> {
  const python = await pythonInvocation()
  if (!python) {
    throw new Error(
      'No Python 3 interpreter is available. NovaPS5 bundles one — repair or reinstall the app.'
    )
  }

  const args = [...python.args, unwrapScriptPath(), input, output]
  if (verbose) args.push('--verbose')

  const { code, stdout, stderr } = await run(python.cmd, args, { timeoutMs: 10 * 60 * 1000 })

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
