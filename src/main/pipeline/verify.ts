import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface LaunchProbe {
  state: 'works' | 'failed'
  /** Human-readable detail: fault summary + exit code, or a short confirmation. */
  detail: string
  /**
   * Set when the runtime aborted because a title probed a trophy id its own
   * package does not define. The installer uses this to retry once with the
   * trophy package hidden.
   */
  trophyAbort?: TrophyAbort | null
}

export interface TrophyAbort {
  trophyId: number
  packagePath: string
}

const LOG_PREFIX = 'novaps5-launch-'

/** Common Windows exception codes → plain language. */
function describeCode(code: number): string {
  const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`
  const names: Record<number, string> = {
    0xc0000005: 'access violation',
    0xc0000008: 'invalid handle',
    0xc000001d: 'illegal instruction',
    0xc000007b: 'invalid image format',
    0xc0000094: 'divide by zero',
    0xc0000135: 'required DLL not found',
    0xc000013a: 'terminated (Ctrl+C or logoff)',
    0xc0000142: 'DLL initialization failed',
    0xc0000409: 'stack buffer overrun / fail-fast',
    0xc0000417: 'invalid parameter / fail-fast'
  }
  const name = names[code >>> 0]
  return name ? `${hex} — ${name}` : hex
}

/**
 * Turn AnyPS5's embedded `--windows-diagnostics` output (and its CPU check)
 * into a precise, actionable verdict instead of "it crashed". Returns null
 * when the log has nothing more specific than the exit code.
 */
function describeRuntimeFailure(text: string): string | null {
  // libkernel's host CPU check prints exactly which Zen 2 extensions are
  // missing — that is the real reason, not the exception that follows.
  const cpuLacks = text.match(/host CPU\s+[^:\n]*:\s*has[^;\n]*;\s*lacks\s+([^\r\n]+)/i)
  if (cpuLacks) {
    const missing = cpuLacks[1].trim()
    // A fully supported CPU still prints the list — as the literal word
    // "none". That is a pass, never the reason the launch failed.
    if (missing && !/^(none|nothing)\b/i.test(missing)) {
      return `this PC's CPU lacks ${missing} — the PS5 title needs those instructions`
    }
  }
  const cpuHost = text.match(/The host CPU \(([^)]+)\)/i)
  if (cpuHost) {
    return `this PC's CPU (${cpuHost[1]}) cannot run instructions the PS5 title uses`
  }

  const missingModule = text.match(/FAIL:\s*dependency module not found:\s*([^\r\n]+)/i)
  if (missingModule) {
    const missing = missingModule[1].trim().replace(/^["']|["']$/g, '')
    return `could not load dependency "${path.basename(missing)}" — it is missing from the install`
  }

  // The runtime's dependency block:
  //   FAIL: unresolved dependency import
  //   Importer: …
  //   Provider: …
  //   Symbol: …
  // The conversion-time equivalent is a single
  //   FAIL: unresolved ELF import <symbol> from <library>
  // line, so accept both shapes.
  const unresolved = text.match(/FAIL:\s*unresolved dependency import([\s\S]{0,500})/i)
  if (unresolved) {
    const block = unresolved[1]
    const provider = block.match(/Provider:\s*([^\r\n]+)/i)?.[1]?.trim()
    const symbol = block.match(/Symbol:\s*([^\r\n]+)/i)?.[1]?.trim()
    if (symbol && provider) {
      return `the game needs "${symbol}" from "${path.basename(provider)}", which the runtime does not provide yet`
    }
    if (symbol) return `the game needs the imported function "${symbol}", which the runtime does not provide yet`
    return 'the game imports a function the conversion runtime does not implement yet'
  }

  // The converted entry point resolves every import before it transfers
  // control. AnyPS5 prints one line per missing NID, then the searched library
  // list and `GetLastError: 127`. Report the scale and the providers instead of
  // one arbitrary symbol.
  const unresolvedElf = [
    ...text.matchAll(/FAIL:\s*unresolved ELF import\s+(\S+)(?:\s+from\s+(\S+))?/gi)
  ]
  if (unresolvedElf.length > 0) {
    const symbols = new Set(unresolvedElf.map((match) => match[1]))
    const providers = [
      ...new Set(
        unresolvedElf
          .map((match) => match[2])
          .filter((value): value is string => Boolean(value))
          .map((value) => path.basename(value))
      )
    ].sort()
    const imports = `${symbols.size} function${symbols.size === 1 ? '' : 's'}`
    const from = providers.length > 0 ? ` from ${providers.join(', ')}` : ''
    return `the game asks for ${imports}${from} that the AnyPS5 runtime does not implement — the converted entry point aborts before the title runs`
  }

  if (/GetLastError:\s*127\b/i.test(text)) {
    return 'Windows could not resolve a function the converted game imports (error 127) — the AnyPS5 runtime does not export it'
  }

  const notPe = text.match(/FAIL:\s*dependency module is not a Windows PE image:\s*([^\r\n]+)/i)
  if (notPe) {
    return `"${path.basename(notPe[1].trim())}" is not a valid Windows library — the install is corrupted`
  }

  if (/FAIL:\s*invalid or unsupported PE dependency metadata/i.test(text)) {
    return 'the converted executable has unreadable dependency metadata — retry the installation'
  }
  if (/FAIL:\s*dependency diagnostics capacity exceeded/i.test(text)) {
    return 'the game has too many dependencies for the runtime to diagnose'
  }
  if (/FAIL:\s*dependency diagnostics Windows API failed/i.test(text)) {
    return 'Windows could not inspect the game’s dependencies during startup'
  }

  // AnyPS5 0.1.3 throws std::invalid_argument from
  // sceNpTrophy2GetTrophyInfo when the id is not in the title's package. The
  // guest turns that into an uncaught exception and aborts. Titles that use the
  // invalid id as a loop sentinel (probe 0, 1, 2, ... until it fails) hit this
  // within the first second.
  const trophy = detectTrophyAbort(text)
  if (trophy) {
    const packageName = path.basename(trophy.packagePath)
    return `the game asked for trophy ${trophy.trophyId}, which ${packageName} does not define — the AnyPS5 runtime aborts instead of returning the invalid-trophy error (hide the trophy package to run with placeholder trophy data)`
  }

  return null
}

/**
 * The runtime's abort for a trophy id the title's package does not define.
 * The message comes from the shipped libSceNpTrophy2.prx:
 *   what():  sceNpTrophy2GetTrophyInfo: trophy 35 is not in /app0/sce_sys/...
 */
export function detectTrophyAbort(text: string): TrophyAbort | null {
  const match = text.match(
    /sceNpTrophy2GetTrophyInfo:\s*trophy\s+(\d+)\s+is not in\s+([^\r\n]+)/i
  )
  if (!match) return null
  return { trophyId: Number(match[1]), packagePath: match[2].trim() }
}

/**
 * Turn the game's own crash report (the AnyPS5 runtime prints a FATAL block
 * with thread + faulting module) into a one-line professional verdict.
 */
function summarizeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  logPath: string
): { detail: string; trophyAbort: TrophyAbort | null } {
  let text = ''
  try {
    text = fs.readFileSync(logPath, 'utf8')
  } catch {
    /* no log — fall back to the exit code alone */
  }

  const trophyAbort = detectTrophyAbort(text)
  const diagnosis = describeRuntimeFailure(text)
  if (diagnosis) return { detail: diagnosis, trophyAbort }

  const fatal = text.match(
    /^FATAL: unhandled exception (0x[0-9a-f]+)[^\n]*?on thread \d+ '([^']*)'/im
  )
  const rip = text.match(/^\s*rip \S+ (\S+)/m)
  if (fatal) {
    const fault = describeCode(parseInt(fatal[1], 16))
    const where = rip ? ` at ${rip[1]}` : ''
    const thread = fatal[2] ? `, thread '${fatal[2]}'` : ''
    return { detail: `crashed (${fault})${where}${thread}`, trophyAbort }
  }

  if (signal) return { detail: `killed by ${signal}`, trophyAbort }
  if (code === null) return { detail: 'exited without an exit code', trophyAbort }
  if (code === 0) return { detail: 'exited immediately with code 0', trophyAbort }
  if (code < 0 || code >= 0xc0000000) {
    return { detail: `crashed (${describeCode(code)})`, trophyAbort }
  }

  // No crash report — show the last lines of output as context, if any.
  const tail = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ')
  return {
    detail: tail ? `exited with code ${code} — ${tail}` : `exited with code ${code}`,
    trophyAbort
  }
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
        const summary = summarizeExit(code, signal, logPath)
        finish({ state: 'failed', detail: summary.detail, trophyAbort: summary.trophyAbort })
      }, 150)
    })

    timer = setTimeout(() => {
      finish({ state: 'works', detail: `still running after ${Math.round(ms / 1000)}s` })
    }, ms)
  })
}
