import { promises as fsp } from 'fs'
import path from 'path'
import type { Game, GamePerformanceProfile } from '@shared/types'

/**
 * AnyPS5 gates its 119.88 Hz video-out mode on this bit in the title's
 * `param.json` (`GetAppAttribute3_nid_no_patch() & 0x40`). Without it, the
 * runtime keeps its vblank/flip clock at 59.94 Hz no matter which present mode
 * is selected, so a title can never present faster than ~60 FPS.
 */
export const ATTRIBUTE3_HIGH_FRAME_RATE = 0x40

/** Read `attribute3` from a parsed param.json, tolerating unusual values. */
function attribute3Of(raw: string): { value: number | null; detail?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { value: null, detail: 'The game’s param.json is not valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { value: null, detail: 'The game’s param.json is not a JSON object.' }
  }
  const value = (parsed as { attribute3?: unknown }).attribute3
  if (value === undefined) {
    return {
      value: 0,
      detail: 'The game’s param.json has no attribute3 field, so the runtime treats it as 0.'
    }
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    return {
      value: null,
      detail: 'The game’s param.json has an attribute3 value the runtime does not accept.'
    }
  }
  return { value: value >>> 0 }
}

/**
 * A read-only view of the title metadata that decides whether the 119.88 Hz
 * output path is even possible. Nothing here changes the installation; it only
 * lets the UI explain a 60 FPS plateau instead of offering a fake unlock.
 */
export async function readPerformanceProfile(game: Game): Promise<GamePerformanceProfile> {
  const paramJson = path.join(game.installPath, 'app0', 'sce_sys', 'param.json')
  let raw: string
  try {
    raw = await fsp.readFile(paramJson, 'utf8')
  } catch {
    return {
      attribute3: null,
      highFrameRate: null,
      source: 'none',
      detail:
        'NovaPS5 could not read this game’s app0/sce_sys/param.json, so its 120 Hz output flag is unknown.'
    }
  }

  const { value, detail } = attribute3Of(raw)
  return {
    attribute3: value,
    highFrameRate: value === null ? null : (value & ATTRIBUTE3_HIGH_FRAME_RATE) !== 0,
    source: 'param.json',
    detail
  }
}
