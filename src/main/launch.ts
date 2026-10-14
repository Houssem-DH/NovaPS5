import { spawn } from 'child_process'
import { getGame, touchPlay } from './library'

/**
 * Start a converted game. The working directory MUST be the install folder so
 * the AnyPS5 runtime resolves /app0/ to <installDir>/app0. The process is
 * detached so closing the library doesn't kill a running game.
 */
export async function launchGame(id: string): Promise<{ ok: boolean; error?: string }> {
  const game = await getGame(id)
  if (!game) return { ok: false, error: 'Game not found in library.' }

  try {
    const child = spawn(game.exePath, [], {
      cwd: game.installPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
    await touchPlay(id)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
