import { spawn } from 'child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  onOutput?: (chunk: string) => void
  /** Kill the process if it exceeds this many ms. */
  timeoutMs?: number
}

/** Spawn a process and resolve with its exit code and captured output. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      // On Windows, .py/.exe resolution is more reliable without a shell, but we
      // still avoid shell interpolation entirely (no command-injection surface).
      shell: false
    })

    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs)
    }

    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString()
      stdout += s
      opts.onOutput?.(s)
    })
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      opts.onOutput?.(s)
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Pull the most useful line out of a tool's output for an error message. */
export function extractFailure(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const fail = lines.find((l) => /^FAIL:/i.test(l))
  if (fail) return fail.replace(/^FAIL:\s*/i, '')
  const last = lines[lines.length - 1]
  return last ?? null
}
