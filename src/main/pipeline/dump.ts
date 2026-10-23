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

// Patch/update trees often sit beside the base game in the same archive. They
// contain a sce_sys/ too, so they must never win over the real dump root.
const PENALIZED_ROOT = /(^|[\\/])(update|updates|patch|patches|dlc|bonus|preorder)([\\/]|$)/i

interface RootCandidate {
  path: string
  score: number
  hasEboot: boolean
}

async function findDumpRoot(dir: string, depth: number, maxDepth: number): Promise<RootCandidate | null> {
  if (depth > maxDepth) return null
  const hasEboot = fs.existsSync(path.join(dir, 'eboot.bin'))
  const hasSceSys = fs.existsSync(path.join(dir, 'sce_sys'))
  const penalty = PENALIZED_ROOT.test(dir) ? 100 : 0

  // A directory with eboot.bin is a complete root — no need to search inside
  // it (and doing so would be expensive for a 100 GB dump).
  if (hasEboot) return { path: dir, score: 1000 - depth - penalty, hasEboot }

  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return hasSceSys ? { path: dir, score: 100 - depth - penalty, hasEboot } : null
  }

  const children = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'sce_sys' &&
        entry.name !== '__MACOSX' &&
        !entry.name.startsWith('.')
    )
    // Search the base game before update/patch trees, then alphabetically so
    // the choice is deterministic across filesystems.
    .sort(
      (a, b) =>
        Number(PENALIZED_ROOT.test(a.name)) - Number(PENALIZED_ROOT.test(b.name)) ||
        a.name.localeCompare(b.name)
    )

  let best: RootCandidate | null = hasSceSys
    ? { path: dir, score: 100 - depth - penalty, hasEboot }
    : null

  for (const entry of children) {
    const found = await findDumpRoot(path.join(dir, entry.name), depth + 1, maxDepth)
    if (!found) continue
    // Prefer the first unpenalized complete root.
    if (found.hasEboot && !PENALIZED_ROOT.test(found.path)) return found
    if (!best || found.score > best.score) best = found
  }
  return best
}

/**
 * Find the dump root. Archives and some dumps nest the actual content one or
 * two folders deep, so search a few levels for a directory with eboot.bin.
 * Update/patch folders are searched last and never beat a base game.
 */
export async function locateDumpRoot(dir: string, depth = 0): Promise<string | null> {
  const found = await findDumpRoot(dir, depth, 6)
  return found?.path ?? null
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

/** "Game.zip" / "Game.tar.gz" → "Game", for archives with no title metadata. */
export function sourceFallbackName(sourcePath: string): string {
  return path.basename(sourcePath).replace(/\.(zip|rar|7z|tar|tgz|tar\.gz|tar\.xz)$/i, '')
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
      if (name === path.basename(sourceDir)) {
        const localized = Object.entries(sfo).find(
          ([key, value]) => /^TITLE_[A-Z]{2}$/i.test(key) && value.trim()
        )?.[1]
        const title = sfo.TITLE?.trim() || localized?.trim()
        if (title) name = title
      }
    } catch {
      // no / unreadable param.sfo either — folder name stays
    }
  }

  for (const candidate of ['icon0.png', 'pic0.png', 'pic1.png']) {
    try {
      await fsp.access(path.join(sourceDir, 'sce_sys', candidate))
      hasCover = true
      break
    } catch {
      /* try the next artwork file */
    }
  }

  return { name, titleId, hasCover }
}

/**
 * Extract a dump archive (.zip, .rar, .7z, .tar…) using the Windows bsdtar —
 * libarchive-based, so the common formats work with the same invocation.
 * Plain ZIPs fall back to PowerShell when tar is missing or rejects the file
 * (older Windows builds, unusual ZIP features).
 */
async function extractArchive(archive: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  let detail = ''

  try {
    const result = await run('tar', ['-xf', archive, '-C', dest], {
      timeoutMs: 30 * 60 * 1000
    })
    if (result.code === 0 && !result.timedOut) return
    detail = result.timedOut
      ? 'extraction timed out after 30 minutes'
      : result.stderr.trim() || `tar exited with code ${result.code}`
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error)
  }

  if (process.platform === 'win32' && /\.zip$/i.test(archive)) {
    const esc = (p: string): string => p.replace(/'/g, "''")
    try {
      const result = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath '${esc(archive)}' -DestinationPath '${esc(dest)}' -Force`
        ],
        { timeoutMs: 30 * 60 * 1000 }
      )
      if (result.code === 0 && !result.timedOut) return
      detail = result.stderr.trim() || detail
    } catch (error) {
      detail = error instanceof Error ? error.message : detail
    }
  }

  if (/no space left|not enough space|disk full|ENOSPC/i.test(detail)) {
    throw new Error(
      `Not enough free space to extract "${path.basename(archive)}" — archives are unpacked to the system temp folder (${app.getPath('temp')}) first. Free space on that drive, or extract the archive yourself and import the folder.`
    )
  }
  if (/passphrase|password|encrypted/i.test(detail)) {
    throw new Error(
      `The archive is password-protected — extract "${path.basename(archive)}" first, then import the folder.`
    )
  }
  if (/unrecognized archive format|not supported|unsupported/i.test(detail)) {
    throw new Error(
      `The archive format could not be read — extract "${path.basename(archive)}" with an archive tool, then import the extracted folder.`
    )
  }
  throw new Error(
    `Could not extract "${path.basename(archive)}" — ${detail || 'the extractor produced no output'}`
  )
}

/**
 * Resolve a user-supplied path (folder or archive) to a dump root. If an
 * archive was extracted, `tempDir` holds the extraction directory and the
 * caller must delete it when finished.
 */
export async function resolveSource(
  sourcePath: string
): Promise<{ root: string; tempDir: string | null }> {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`The selected source no longer exists: ${sourcePath}`)
  }
  if (/\.(zip|rar|7z|tar|tgz|tar\.gz|tar\.xz)$/i.test(sourcePath)) {
    const tempDir = path.join(
      app.getPath('temp'),
      `ps5lib-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    )
    try {
      await extractArchive(sourcePath, tempDir)
    } catch (error) {
      // Never leave a half-extracted archive behind when the import fails.
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    const root = (await locateDumpRoot(tempDir)) ?? tempDir
    return { root, tempDir }
  }
  // A file that is not an archive cannot be a dump root. Say so directly
  // instead of walking it and reporting "no eboot.bin".
  let sourceIsFile = false
  try {
    sourceIsFile = (await fsp.stat(sourcePath)).isFile()
  } catch {
    // missing path — locateDumpRoot/install will report it
  }
  if (sourceIsFile) {
    throw new Error(
      `"${path.basename(sourcePath)}" is not a supported archive — use .zip, .rar, .7z, .tar, .tar.gz, or .tar.xz.`
    )
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
    // Archived dumps have a random temp-folder name; when no title metadata
    // exists, the archive's own name is far more useful than "ps5lib-…".
    const displayName =
      resolved.tempDir && meta.name === path.basename(root)
        ? sourceFallbackName(sourcePath)
        : meta.name
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
      name: displayName,
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
