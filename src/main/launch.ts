import { spawn } from 'child_process'
import { normalizeGameCompatibility, normalizeGameGraphics } from '@shared/types'
import type { GameGraphics } from '@shared/types'
import { getGame, touchPlay } from './library'
import { beginSession, createTelemetryDir, finishSession } from './session'
import { setTrophyDataMode } from './trophy'

/**
 * Turn the per-game settings into the environment variables AnyPS5 reads.
 * The values mirror the runtime's documented launch controls; no render
 * resolution or upscaler setting is invented here.
 */
function graphicsEnvironment(graphics?: GameGraphics): NodeJS.ProcessEnv {
  const settings = normalizeGameGraphics(graphics)
  const env: NodeJS.ProcessEnv = { ...process.env }

  env.ANYPS5_PRESENT_MODE = settings.presentMode

  const gpu = settings.gpu?.trim()
  if (gpu) env.ANYPS5_GPU = gpu
  else delete env.ANYPS5_GPU

  if (settings.overlay) {
    env.ANYPS5_OVERLAY = '1'
    env.ANYPS5_OVERLAY_POS = settings.overlayPosition
  } else {
    delete env.ANYPS5_OVERLAY
    delete env.ANYPS5_OVERLAY_POS
  }

  if (settings.shaderCache) delete env.ANYPS5_NO_SHADER_CACHE
  else env.ANYPS5_NO_SHADER_CACHE = '1'

  // These only add detail to the AnyPS5 performance overlay (GPU/DRIVER
  // lines). They are real runtime profiling switches and add overhead, so
  // they stay opt-in and must not leak in from the parent process.
  if (settings.gpuProfile) env.APS5_PROFILE_GPU = '1'
  else delete env.APS5_PROFILE_GPU

  if (settings.drawProfile) env.APS5_PROFILE_DRAW = '1'
  else delete env.APS5_PROFILE_DRAW

  return env
}

/**
 * Start a converted game. The working directory MUST be the install folder so
 * the AnyPS5 runtime resolves /app0/ to <installDir>/app0. The process is
 * detached so closing the library doesn't kill a running game.
 */
export async function launchGame(id: string): Promise<{ ok: boolean; error?: string }> {
  const game = await getGame(id)
  if (!game) return { ok: false, error: 'Game not found in library.' }
  if (game.status === 'error') {
    return { ok: false, error: game.error ?? 'This game is not working and cannot be launched.' }
  }

  const graphics = normalizeGameGraphics(game.graphics)
  const env = graphicsEnvironment(graphics)

  // The trophy mode renames files inside the install, and a fresh install (or
  // a hand-edited folder) can be out of step with the library entry. Re-apply
  // it on every launch so the mode the user sees is the mode AnyPS5 gets.
  const compatibility = normalizeGameCompatibility(game.compatibility)
  const trophies = await setTrophyDataMode(game.installPath, compatibility.trophyData)
  if (trophies.error) return { ok: false, error: trophies.error }

  let telemetryDir: string | null = null
  if (graphics.telemetry) {
    try {
      telemetryDir = await createTelemetryDir(game.id)
      env.APS5_VIDEOOUT_TELEMETRY_DIR = telemetryDir
    } catch {
      // Monitoring is a nice-to-have; a read-only userData folder must not
      // stop the game from starting.
      delete env.APS5_VIDEOOUT_TELEMETRY_DIR
    }
  } else {
    delete env.APS5_VIDEOOUT_TELEMETRY_DIR
  }

  try {
    const child = spawn(game.exePath, [], {
      cwd: game.installPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env
    })

    child.on('error', () => {
      // Without a listener an async spawn error would crash the main process.
      if (child.pid !== undefined) finishSession(id, child.pid)
    })

    if (child.pid !== undefined) {
      beginSession(id, child.pid, telemetryDir)
      child.on('exit', () => finishSession(id, child.pid))
    }

    child.unref()
    await touchPlay(id)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
