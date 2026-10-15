import { execFile } from 'child_process'
import fs from 'fs'
import { promisify } from 'util'
import { bundledPythonExe } from './paths'

const execFileAsync = promisify(execFile)

export interface PythonInvocation {
  /** Executable to run (absolute path for the bundled interpreter). */
  cmd: string
  /** Leading arguments (e.g. `-3` for the Windows launcher). */
  args: string[]
  /** True when this is the interpreter that ships with NovaPS5. */
  bundled: boolean
}

let cached: PythonInvocation | null | undefined

/**
 * A fresh embeddable Python can print its version to either stream, and the
 * Microsoft Store `python` alias prints a banner instead — verify by parsing
 * `--version` output before trusting any candidate.
 */
async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, [...args, '--version'], {
      windowsHide: true,
      timeout: 10_000
    })
    return /Python\s+3\./i.test(`${stdout}${stderr}`)
  } catch {
    return false
  }
}

/**
 * Locate a usable Python 3 interpreter, preferring the one bundled with the
 * app (so a plain install never needs Python on the user's machine).
 */
export async function pythonInvocation(): Promise<PythonInvocation | null> {
  if (cached !== undefined) return cached

  const bundled = bundledPythonExe()
  if (fs.existsSync(bundled) && (await probe(bundled, []))) {
    cached = { cmd: bundled, args: [], bundled: true }
    return cached
  }

  const candidates: PythonInvocation[] = [
    { cmd: 'py', args: ['-3'], bundled: false },
    { cmd: 'python', args: [], bundled: false },
    { cmd: 'python3', args: [], bundled: false }
  ]

  for (const candidate of candidates) {
    if (await probe(candidate.cmd, candidate.args)) {
      cached = candidate
      return cached
    }
  }

  cached = null
  return null
}

/** Human-readable interpreter reference for the UI (e.g. an absolute path). */
export async function findPython(): Promise<string | null> {
  const invocation = await pythonInvocation()
  if (!invocation) return null
  return invocation.args.length ? `${invocation.cmd} ${invocation.args.join(' ')}` : invocation.cmd
}

/** Reset the cached lookup (used by tests / settings changes). */
export function resetPythonCache(): void {
  cached = undefined
}
