import { app } from 'electron'
import { promises as fsp } from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import type { GameSession, GameSessionSample } from '@shared/types'

/**
 * AnyPS5 can append videoout.jsonl when APS5_VIDEOOUT_TELEMETRY_DIR is set.
 * NovaPS5 gives every launch its own folder, then tails the `present` lines to
 * show a live FPS graph. The runtime only samples every 30 presented frames,
 * so this is a monitoring aid, not a frame-by-frame profiler.
 */
interface SessionRecord {
  gameId: string
  pid?: number
  startedAt: number
  endedAt?: number
  telemetryPath: string | null
  samples: GameSessionSample[]
  dropped: number
  lastSampleAt?: number
  /** Last observed telemetry file state, so a closed game is not re-read every poll. */
  telemetrySize?: number
  telemetryMtimeMs?: number
}

const MAX_SAMPLES = 240
const TAIL_BYTES = 512 * 1024
/** Keep enough telemetry folders for recent troubleshooting without growing forever. */
const KEEP_TELEMETRY_SESSIONS = 20
const sessions = new Map<string, SessionRecord>()

export function telemetryRoot(): string {
  return path.join(app.getPath('userData'), 'telemetry')
}

export async function createTelemetryDir(gameId: string): Promise<string> {
  const safeId = gameId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'game'
  const parent = path.join(telemetryRoot(), safeId)
  const dir = path.join(parent, String(Date.now()))
  await fsp.mkdir(dir, { recursive: true })

  // A small bounded history keeps disk use predictable on long-lived installs.
  try {
    const entries = await fsp.readdir(parent, { withFileTypes: true })
    const previous = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    for (const stale of previous.slice(0, Math.max(0, previous.length - KEEP_TELEMETRY_SESSIONS))) {
      await fsp.rm(path.join(parent, stale), { recursive: true, force: true })
    }
  } catch {
    // Retention is best effort; the current session folder is already usable.
  }

  return dir
}

export function beginSession(gameId: string, pid: number, telemetryDir: string | null): void {
  sessions.set(gameId, {
    gameId,
    pid,
    startedAt: Date.now(),
    telemetryPath: telemetryDir ? path.join(telemetryDir, 'videoout.jsonl') : null,
    samples: [],
    dropped: 0,
    lastSampleAt: undefined,
    telemetrySize: undefined,
    telemetryMtimeMs: undefined
  })
}

export function finishSession(gameId: string, pid?: number): void {
  const session = sessions.get(gameId)
  if (!session) return
  if (pid !== undefined && session.pid !== undefined && session.pid !== pid) return
  session.endedAt = Date.now()
}

/** Parse the newest slice of the telemetry file; tolerate a partial first line. */
function parseTelemetry(text: string, fromStart: boolean): { samples: GameSessionSample[]; dropped: number } {
  const lines = text.split('\n')
  if (!fromStart && lines.length > 0) lines.shift()
  const samples: GameSessionSample[] = []
  let dropped = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed) as {
        ev?: string
        t_ns?: number
        fps?: number
        dropped?: number
      }
      if (
        entry.ev === 'present' &&
        typeof entry.fps === 'number' &&
        Number.isFinite(entry.fps) &&
        typeof entry.t_ns === 'number'
      ) {
        samples.push({ t: Math.round(entry.t_ns / 1e6), fps: Math.max(0, entry.fps) })
      } else if (entry.ev === 'drops' && typeof entry.dropped === 'number') {
        dropped = Math.max(dropped, entry.dropped)
      }
    } catch {
      // A line still being written; the next poll picks it up.
    }
  }
  return { samples, dropped }
}

async function readTelemetryFile(file: string): Promise<{ samples: GameSessionSample[]; dropped: number }> {
  let handle: FileHandle | null = null
  try {
    handle = await fsp.open(file, 'r')
    const stat = await handle.stat()
    const fromStart = stat.size <= TAIL_BYTES
    // Include one byte before the tail window. If the window happens to start
    // on a line boundary, that byte is the preceding newline, so the
    // "drop the partial first line" rule stays correct for every offset.
    const start = fromStart ? 0 : Math.max(0, stat.size - TAIL_BYTES - 1)
    const length = stat.size - start
    if (length <= 0) return { samples: [], dropped: 0 }
    const buffer = Buffer.alloc(Number(length))
    await handle.read(buffer, 0, buffer.length, start)
    return parseTelemetry(buffer.toString('utf8'), fromStart)
  } catch {
    return { samples: [], dropped: 0 }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Read live metrics. The record survives the game exiting so the UI can keep
 * showing a "last session" summary until the next launch.
 */
export async function readSession(gameId: string): Promise<GameSession> {
  const session = sessions.get(gameId)
  if (!session) {
    return { active: false, telemetry: false, samples: [], dropped: 0 }
  }

  if (session.telemetryPath) {
    try {
      const stat = await fsp.stat(session.telemetryPath)
      const changed =
        stat.size !== session.telemetrySize || stat.mtimeMs !== session.telemetryMtimeMs
      if (changed) {
        session.telemetrySize = stat.size
        session.telemetryMtimeMs = stat.mtimeMs
        const { samples, dropped } = await readTelemetryFile(session.telemetryPath)
        if (samples.length > 0) {
          const previousLast = session.samples[session.samples.length - 1]?.t
          const nextLast = samples[samples.length - 1]?.t
          if (previousLast === undefined || (nextLast !== undefined && nextLast > previousLast)) {
            session.lastSampleAt = Date.now()
          }
          session.samples = samples.slice(-MAX_SAMPLES)
        }
        if (dropped > session.dropped) session.dropped = dropped
      }
    } catch {
      // The runtime creates the file on its first presentation; retry next poll.
    }
  }

  const active = session.endedAt === undefined
  return {
    active,
    pid: session.pid,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    telemetry: session.telemetryPath !== null,
    samples: session.samples,
    dropped: session.dropped,
    lastSampleAt: session.lastSampleAt
  }
}
