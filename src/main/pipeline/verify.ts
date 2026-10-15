import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface LaunchProbe {
  state: 'works' | 'failed'
  /** Human-readable detail: fault summary + exit code, or a short confirmation. */
  detail: string
}

const LOG_PREFIX = 'novaps5-launch-'

/** Common Windows exception codes → plain language. */
function describeCode(code: number): string {
  const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`
  const names: Record<number, string> = {
    0xc0000005: 'access violation',
    0xc0000008: 'invalid handle',
    0xc000001d: 'illegal instruction',
    0xc0000094: 'divide by zero',
    0xc000013a: 'terminated (Ctrl+C or logoff)',
    0xc0000142: 'DLL initialization failed',
    0xc0000409: 'stack buffer overrun / fail-fast',
    0xc0000417: 'invalid parameter / fail-fast'
  }
  const name = names[code >>> 0]
  return name ? `${hex} — ${name}` : hex
}

/**
 * Turn the game's own crash report (the AnyPS5 runtime prints a FATAL block
 * with thread + faulting module) into a one-line professional verdict.
 */
function summarizeExit(code: number | null, signal: NodeJS.Signals | null, logPath: string): string {
  let text = ''
  try {
    text = fs.readFileSync(logPath, 'utf8')
  } catch {
    /* no log — fall back to the exit code alone */
  }

  const fatal = text.match(
    /^FATAL: unhandled exception (0x[0-9a-f]+)[^\n]*?on thread \d+ '([^']*)'/im
  )
  const rip = text.match(/^\s*rip \S+ (\S+)/m)
  if (fatal) {
    const fault = describeCode(parseInt(fatal[1], 16))
    const where = rip ? ` at ${rip[1]}` : ''
    const thread = fatal[2] ? `, thread '${fatal[2]}'` : ''
    return `crashed (${fault})${where}${thread}`
  }

  if (signal) return `killed by ${signal}`
  if (code === null) return 'exited without an exit code'
  if (code === 0) return 'exited immediately with code 0'
  if (code < 0 || code >= 0xc0000000) return `crashed (${describeCode(code)})`

  // No crash report — show the last lines of output as context, if any.
  const tail = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ')
  return tail ? `exited with code ${code} — ${tail}` : `exited with code ${code}`
}

/**
 * Post-install launch test: start the converted game and watch it.
 *
 *  - still running after `ms`  -> state 'works' (left running on purpose: the
 *    user asked for verification and wants to see the game)
 *  - exited / failed to start  -> state 'failed' with the runtime's own crash
 *    summary (faulting module, exception code)
 *
 * stdout/stderr go to a temp FILE rather than pipes, and the game is spawned
 * detached — so a verified game keeps running after NovaPS5 closes and never
 * dies from a broken pipe. Never throws: a failed probe must never fail the
 * installation itself.
 */
export async function probeLaunch(exePath: string, cwd: string, ms = 10_000): Promise<LaunchProbe> {
  // Sweep stale logs left behind by games that kept running after a probe.
  try {
    const tmp = os.tmpdir()
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const file of fs.readdirSync(tmp)) {
      if (!file.startsWith(LOG_PREFIX)) continue
      const full = path.join(tmp, file)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
      } catch {
        /* ignore one stubborn file */
      }
    }
  } catch {
    /* best effort */
  }

  const logPath = path.join(
    os.tmpdir(),
    `${LOG_PREFIX}${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`
  )
  let logFd: number | null = null
  try {
    logFd = fs.openSync(logPath, 'w')
  } catch {
    logFd = null
  }

  const closeLog = (): void => {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd)
      } catch {
        /* ignore */
      }
      logFd = null
    }
  }

  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (probe: LaunchProbe): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      closeLog()
      // A still-running game holds the log open — deletion then fails silently,
      // which is fine (the sweep above reclaims it later).
      try {
        fs.rmSync(logPath, { force: true })
      } catch {
        /* ignore */
      }
      resolve(probe)
    }

    let child: ChildProcess
    try {
      child = spawn(exePath, [], {
        cwd,
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
        windowsHide: false
      })
    } catch (error) {
      finish({ state: 'failed', detail: error instanceof Error ? error.message : String(error) })
      return
    }

    child.on('error', (error) => {
      finish({ state: 'failed', detail: error.message })
    })

    // Detached + unref'd: a verified game survives NovaPS5 closing (and a
    // headless harness exiting) without keeping our event loop alive.
    child.unref()

    child.on('exit', (code, signal) => {
      // Stop the "works" timeout first — a game that dies at 9.95s must not
      // be reported as still running at 10s. Then let the runtime flush its
      // crash report before reading the log.
      if (timer) clearTimeout(timer)
      setTimeout(() => {
        finish({ state: 'failed', detail: summarizeExit(code, signal, logPath) })
      }, 150)
    })

    timer = setTimeout(() => {
      finish({ state: 'works', detail: `still running after ${Math.round(ms / 1000)}s` })
    }, ms)
  })
}
