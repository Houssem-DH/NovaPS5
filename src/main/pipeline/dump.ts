import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { app } from 'electron'
import { run } from './run'
import { dirSize } from './copy'
import { checkCompatibility } from './compat'
import type { DetectResult } from '@shared/types'

/** Does this directory look like the root of a PS5 dump? */
export function looksLikeDump(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'eboot.bin')) || fs.existsSync(path.join(dir, 'sce_sys'))
}

/**
 * Find the dump root. Archives and some dumps nest the actual content one or
 * two folders deep, so search a few levels for a directory that has eboot.bin.
 */
export async function locateDumpRoot(dir: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null
  if (looksLikeDump(dir)) return dir

  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await locateDumpRoot(path.join(dir, entry.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

/** Read a PS4/PS5 param.sfo (binary PSF) into a flat key → value map. */
function parseParamSfo(buffer: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  // "\0PSF" little-endian, header: magic, version, keyTableStart,
  // dataTableStart, indexTableEntries — then 16-byte index records.
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46535000) return out
  const keyTableStart = buffer.readUInt32LE(8)
  const dataTableStart = buffer.readUInt32LE(12)
  const indexCount = buffer.readUInt32LE(16)
  for (let i = 0; i < indexCount; i++) {
    const entry = 20 + i * 16
    if (entry + 16 > buffer.length) break
    const keyOffset = buffer.readUInt16LE(entry)
    const dataLen = buffer.readUInt32LE(entry + 4)
    const dataOffset = buffer.readUInt32LE(entry + 12)
    const keyStart = keyTableStart + keyOffset
    const keyEnd = buffer.indexOf(0, keyStart)
    const dataStart = dataTableStart + dataOffset
    if (keyEnd < 0 || dataStart + dataLen > buffer.length) continue
    const key = buffer.toString('utf8', keyStart, keyEnd)
    if (!key) continue
    // String values (TITLE, TITLE_ID, …) are UTF-8 zero-padded to dataLen;
    // numeric entries decode to garbage and are simply never looked up.
    out[key] = buffer.toString('utf8', dataStart, dataStart + dataLen).replace(/\0+$/, '')
  }
  return out
}

/** Extract the title name, title id, and cover presence from sce_sys. */
export async function readMeta(
  sourceDir: string
): Promise<{ name: string; titleId: string | null; hasCover: boolean }> {
  let name = path.basename(sourceDir)
  let titleId: string | null = null
  let hasCover = false

  try {
    const raw = await fsp.readFile(path.join(sourceDir, 'sce_sys', 'param.json'), 'utf8')
    const json = JSON.parse(raw)
    if (typeof json.titleId === 'string') titleId = json.titleId

    const lp = json.localizedParameters
    if (lp && typeof lp === 'object') {
      const lang = typeof lp.defaultLanguage === 'string' ? lp.defaultLanguage : 'en-US'
      const title = lp[lang]?.titleName ?? lp['en-US']?.titleName
      if (typeof title === 'string' && title.trim()) name = title.trim()
    }
  } catch {
    // no / unreadable param.json — PS4 dumps carry param.sfo instead
  }

  // Fill whatever param.json did not provide from the binary SFO.
  if (!titleId || name === path.basename(sourceDir)) {
    try {
      const sfo = parseParamSfo(await fsp.readFile(path.join(sourceDir, 'sce_sys', 'param.sfo')))
      if (!titleId && sfo.TITLE_ID?.trim()) titleId = sfo.TITLE_ID.trim()
      if (name === path.basename(sourceDir) && sfo.TITLE?.trim()) name = sfo.TITLE.trim()
    } catch {
      // no / unreadable param.sfo either — folder name stays
    }
  }

  try {
    await fsp.access(path.join(sourceDir, 'sce_sys', 'icon0.png'))
    hasCover = true
  } catch {
    /* no cover art */
  }

  return { name, titleId, hasCover }
}

/**
 * Extract a dump archive (.zip, .rar, .7z) using the Windows bsdtar —
 * libarchive-based, so all three formats work with the same invocation.
 */
async function extractArchive(archive: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const { code, stderr } = await run('tar', ['-xf', archive, '-C', dest], {
    timeoutMs: 30 * 60 * 1000
  })
  if (code !== 0) {
    throw new Error(`Could not extract the archive — ${stderr.trim() || `tar exited with code ${code}`}`)
  }
}

/**
 * Resolve a user-supplied path (folder or .zip/.rar/.7z archive) to a dump
 * root. If an archive was extracted, `tempDir` holds the extraction directory
 * and the caller must delete it when finished.
 */
export async function resolveSource(
  sourcePath: string
): Promise<{ root: string; tempDir: string | null }> {
  if (/\.(zip|rar|7z)$/i.test(sourcePath)) {
    const tempDir = path.join(app.getPath('temp'), `ps5lib-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
    await extractArchive(sourcePath, tempDir)
    const root = (await locateDumpRoot(tempDir)) ?? tempDir
    return { root, tempDir }
  }
  const root = (await locateDumpRoot(sourcePath)) ?? sourcePath
  return { root, tempDir: null }
}

/** Cheap pre-install check: is this a usable dump, and what is it? */
export async function detectDump(sourcePath: string): Promise<DetectResult> {
  let tempDir: string | null = null
  try {
    const resolved = await resolveSource(sourcePath)
    tempDir = resolved.tempDir
    const root = resolved.root

    if (!fs.existsSync(path.join(root, 'eboot.bin'))) {
      return { isDump: false, reason: 'No eboot.bin found — this does not look like a PS5 game dump.' }
    }

    const meta = await readMeta(root)
    // Full-tree size (unwrap backups excluded) — dumps differ in layout, so
    // don't assume a fixed set of folders.
    let sizeBytes = 0
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (entry.name.endsWith('.esbak')) continue
      sizeBytes += await dirSize(path.join(root, entry.name))
    }

    // Compatibility report — "will this convert?" before anything is copied.
    const compat = await checkCompatibility(root)

    return {
      isDump: true,
      name: meta.name,
      titleId: meta.titleId,
      hasCover: meta.hasCover,
      sizeBytes,
      checks: compat.checks,
      compatible: compat.compatible
    }
  } catch (error) {
    return { isDump: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
