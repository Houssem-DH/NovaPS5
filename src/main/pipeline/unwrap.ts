import path from 'path'
import { promises as fsp } from 'fs'
import { run } from './run'
import { unwrapScriptPath } from '../paths'
import { pythonInvocation } from '../python'
import { detectContainer } from './elf'

/**
 * Turn a decrypted SELF container into a clean ELF using AnyPS5's unwrap_self.py.
 * `output` may equal `input` to unwrap in place.
 *
 * In-place unwraps go through a temporary sibling file: the Python script
 * writes the whole ELF before we replace the original, so a crash or an
 * encrypted container can never leave a truncated module behind in the
 * staging folder. The produced file is validated as an ELF before it is
 * handed to the relinker.
 */
export async function unwrapSelf(input: string, output: string, verbose = false): Promise<void> {
  const python = await pythonInvocation()
  if (!python) {
    throw new Error(
      'No Python 3 interpreter is available. NovaPS5 bundles one — repair or reinstall the app.'
    )
  }

  const inPlace = path.resolve(input) === path.resolve(output)
  const target = inPlace
    ? path.join(
        path.dirname(output),
        `.${path.basename(output)}.novaps5-unwrap-${process.pid}-${Date.now()}.tmp`
      )
    : output

  try {
    // A previous run may have left a partial output behind.
    await fsp.rm(target, { force: true }).catch(() => {})

    const args = [...python.args, unwrapScriptPath(), input, target]
    if (verbose) args.push('--verbose')

    const result = await run(python.cmd, args, { timeoutMs: 10 * 60 * 1000 })
    if (result.timedOut) {
      throw new Error(`${path.basename(input)} could not be unwrapped — the step timed out.`)
    }
    if (result.code !== 0) {
      const { stderr, stdout } = result
      const detail = /not a SELF container/i.test(stderr)
        ? `${path.basename(input)} is not a SELF container.`
        : /looks encrypted/i.test(stderr)
          ? `${path.basename(input)} is still encrypted — dump it decrypted before converting.`
          : stderr.trim() || stdout.trim() || `the unwrapper exited with code ${result.code}`
      throw new Error(detail)
    }

    // Exit code 0 is not proof of success: the script can silently produce
    // nothing for a malformed container. Never hand that to the relinker.
    const kind = detectContainer(target)
    if (kind !== 'elf') {
      throw new Error(
        kind === 'unknown'
          ? `${path.basename(input)} did not produce a usable ELF — the file is truncated or uses an unsupported container.`
          : `${path.basename(input)} unwrapped to a ${kind.toUpperCase()} file instead of an ELF — the container is malformed.`
      )
    }

    if (inPlace) await fsp.rename(target, output)
  } catch (error) {
    await fsp.rm(target, { force: true }).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(/^Unwrap failed\b/.test(message) ? message : `Unwrap failed — ${message}`)
  }
}
