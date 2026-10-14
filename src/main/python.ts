import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

let cached: string | null | undefined

/**
 * Locate a usable Python 3 interpreter. On Windows the `python` alias can be the
 * Microsoft Store stub (which prints a banner and exits non-zero / without a
 * version), so every candidate is verified by parsing `--version`.
 */
export async function findPython(): Promise<string | null> {
  if (cached !== undefined) return cached

  const candidates: Array<{ cmd: string; prefixArgs: string[] }> = [
    { cmd: 'py', prefixArgs: ['-3'] },
    { cmd: 'python', prefixArgs: [] },
    { cmd: 'python3', prefixArgs: [] }
  ]

  for (const { cmd, prefixArgs } of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, [...prefixArgs, '--version'], {
        windowsHide: true,
        timeout: 10_000
      })
      const out = `${stdout}${stderr}`
      if (/Python\s+3\./i.test(out)) {
        cached = prefixArgs.length ? `${cmd} ${prefixArgs.join(' ')}` : cmd
        return cached
      }
    } catch {
      // try next candidate
    }
  }

  cached = null
  return null
}

/** Reset the cached lookup (used by tests / settings changes). */
export function resetPythonCache(): void {
  cached = undefined
}
