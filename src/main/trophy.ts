import { promises as fsp } from 'fs'
import path from 'path'
import type { TrophyDataMode, TrophyPackageFile, TrophyPackageInfo } from '@shared/types'

/**
 * AnyPS5 0.1.3 throws from `sceNpTrophy2GetTrophyInfo` when a title asks for a
 * trophy id that its `trophy2/*.ucp` package does not define. Titles use that
 * call as a sentinel loop (probe 0, 1, 2, ... until the runtime reports the
 * invalid id), so the throw reaches the guest as an uncaught
 * `std::invalid_argument` and aborts the process.
 *
 * The same runtime answers every id with placeholder data and returns success
 * when no package is loaded. Renaming the package (keeping the bytes on disk)
 * therefore keeps the title running; only the real trophy names, descriptions
 * and platinum rules are lost for that game. The mode is per game and
 * reversible.
 */
export const TROPHY_HIDDEN_SUFFIX = '.disabled'

const PACKAGE_FILE = /^trophy\d{2}\.ucp(\.disabled)?$/i
const UCP_MAGIC = 0xb228c60a
const UCP_VERSION = 1
const UCP_HEADER_SIZE = 0x40
const UCP_TOC_HEADER_SIZE = 0x20
const UCP_ENTRY_SIZE = 0x40
const UCP_NAME_SIZE = 0x20
const UCP_MAX_ENTRIES = 4096
const UCP_MAX_CONF_BYTES = 4 * 1024 * 1024

export function trophyPackageDir(installPath: string): string {
  return path.join(installPath, 'app0', 'sce_sys', 'trophy2')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isHidden(file: string): boolean {
  return file.toLowerCase().endsWith(TROPHY_HIDDEN_SUFFIX)
}

function packageNameOf(file: string): string {
  return isHidden(file) ? file.slice(0, -TROPHY_HIDDEN_SUFFIX.length) : file
}

function bigEndian(buffer: Buffer, offset: number, size: number): number {
  let value = 0
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + buffer[offset + index]
  }
  return value
}

async function readTrophyCount(file: string): Promise<Pick<TrophyPackageFile, 'trophyCount' | 'idRange'>> {
  let handle: fsp.FileHandle | null = null
  try {
    handle = await fsp.open(file, 'r')
    const header = Buffer.alloc(UCP_HEADER_SIZE)
    const headerRead = await handle.read(header, 0, UCP_HEADER_SIZE, 0)
    if (headerRead.bytesRead < UCP_HEADER_SIZE) return { trophyCount: null, idRange: null }

    // UCP is big-endian: magic, version, total size (u64), entry count, TOC offset.
    if (bigEndian(header, 0, 4) !== UCP_MAGIC || bigEndian(header, 4, 4) !== UCP_VERSION) {
      return { trophyCount: null, idRange: null }
    }
    const totalSize = bigEndian(header, 8, 8)
    const count = bigEndian(header, 0x10, 4)
    const toc = bigEndian(header, 0x14, 4)
    if (
      count <= 0 ||
      count > UCP_MAX_ENTRIES ||
      toc < UCP_HEADER_SIZE ||
      UCP_TOC_HEADER_SIZE + count * UCP_ENTRY_SIZE > totalSize
    ) {
      return { trophyCount: null, idRange: null }
    }

    const tocBytes = Buffer.alloc(UCP_TOC_HEADER_SIZE + count * UCP_ENTRY_SIZE)
    const tocRead = await handle.read(tocBytes, 0, tocBytes.length, toc)
    if (tocRead.bytesRead < tocBytes.length) return { trophyCount: null, idRange: null }

    let entryOffset: number | null = null
    let entrySize = 0
    for (let index = 0; index < count; index += 1) {
      const entry = UCP_TOC_HEADER_SIZE + index * UCP_ENTRY_SIZE
      const name = tocBytes
        .subarray(entry, entry + UCP_NAME_SIZE)
        .toString('utf8')
        .replace(/\0.*$/s, '')
      if (name !== 'tropconf.json') continue
      entryOffset = bigEndian(tocBytes, entry + UCP_NAME_SIZE, 8)
      entrySize = bigEndian(tocBytes, entry + UCP_NAME_SIZE + 8, 8)
      break
    }
    if (entryOffset === null || entrySize === 0 || entrySize > UCP_MAX_CONF_BYTES) {
      return { trophyCount: null, idRange: null }
    }

    const conf = Buffer.alloc(entrySize)
    const confRead = await handle.read(conf, 0, entrySize, entryOffset)
    if (confRead.bytesRead < entrySize) return { trophyCount: null, idRange: null }

    const parsed = JSON.parse(conf.toString('utf8').replace(/^\uFEFF/, '')) as {
      trophies?: Array<{ id?: unknown }>
    }
    if (!Array.isArray(parsed.trophies)) return { trophyCount: null, idRange: null }

    const ids = parsed.trophies
      .map((trophy) => trophy.id)
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .map((id) => String(id))
      .sort()
    return {
      trophyCount: parsed.trophies.length,
      idRange: ids.length > 0 ? [ids[0], ids[ids.length - 1]] : null
    }
  } catch {
    return { trophyCount: null, idRange: null }
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** Describe every trophy package in the install, active or hidden. */
export async function readTrophyPackages(installPath: string): Promise<TrophyPackageInfo> {
  const dir = trophyPackageDir(installPath)
  let names: string[]
  try {
    names = (await fsp.readdir(dir)).filter((name) => PACKAGE_FILE.test(name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { dir, files: [] }
    return { dir, files: [], error: messageOf(error) }
  }

  const files: TrophyPackageFile[] = []
  for (const name of names.sort()) {
    const full = path.join(dir, name)
    let sizeBytes = 0
    try {
      sizeBytes = (await fsp.stat(full)).size
    } catch {
      /* keep 0 */
    }
    const hidden = isHidden(name)
    const details = await readTrophyCount(full)
    files.push({
      file: name,
      packageName: packageNameOf(name),
      disabled: hidden,
      sizeBytes,
      ...details
    })
  }
  files.sort((a, b) =>
    a.packageName === b.packageName
      ? Number(a.disabled) - Number(b.disabled)
      : a.packageName.localeCompare(b.packageName)
  )
  return { dir, files }
}

/**
 * Apply a mode to the install: hide the `.ucp` packages (placeholder data) or
 * restore them. Idempotent; files are renamed, never deleted, so the mode can
 * be switched back at any time.
 */
export async function setTrophyDataMode(
  installPath: string,
  mode: TrophyDataMode
): Promise<{ changed: string[]; error?: string }> {
  const dir = trophyPackageDir(installPath)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { changed: [] }
    return { changed: [], error: `Could not read ${dir}: ${messageOf(error)}` }
  }

  const changed: string[] = []
  const errors: string[] = []
  const present = new Set(names.map((name) => name.toLowerCase()))

  const rename = async (from: string, to: string): Promise<void> => {
    try {
      await fsp.rename(path.join(dir, from), path.join(dir, to))
      changed.push(from)
    } catch (error) {
      errors.push(`${from}: ${messageOf(error)}`)
    }
  }

  if (mode === 'placeholders') {
    for (const name of names) {
      if (isHidden(name) || !PACKAGE_FILE.test(name)) continue
      if (present.has(`${name}${TROPHY_HIDDEN_SUFFIX}`.toLowerCase())) continue
      await rename(name, `${name}${TROPHY_HIDDEN_SUFFIX}`)
    }
  } else {
    for (const name of names) {
      if (!isHidden(name)) continue
      const restored = packageNameOf(name)
      if (present.has(restored.toLowerCase())) continue
      await rename(name, restored)
    }
  }

  return errors.length > 0
    ? { changed, error: `Could not update the trophy package: ${errors.join('; ')}` }
    : { changed }
}
