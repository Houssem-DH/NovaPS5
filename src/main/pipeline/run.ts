import { spawn } from 'child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** True when the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean
}

export interface RunOptions {
  cwd?: string
  onOutput?: (chunk: string) => void
  /** Kill the process if it exceeds this many ms. */
  timeoutMs?: number
}

/**
 * Kill a child plus everything it spawned. The relinker/CPython can spawn
 * helpers on Windows; killing only the direct child can leave them holding
 * file handles inside the staging folder and make cleanup fail.
 */
function killTree(child: import('child_process').ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => {})
      killer.unref()
    } catch {
      /* fall through to child.kill() */
    }
  }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}

/** Spawn a process and resolve with its exit code and captured output. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false

    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

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
        timedOut = true
        killTree(child)
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
      fail(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      finish({ code: code ?? -1, stdout, stderr, timedOut })
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
