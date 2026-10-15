import { promises as fsp } from 'fs'
import path from 'path'

/** Recursively compute the total size of a file or directory in bytes. */
export async function dirSize(target: string): Promise<number> {
  let stat
  try {
    // lstat, not stat: never follow symlinks/junctions — an installed game
    // links libs/ to the shared runtime libraries, which are not its own size.
    stat = await fsp.lstat(target)
  } catch {
    return 0
  }
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size

  let total = 0
  const entries = await fsp.readdir(target, { withFileTypes: true })
  for (const entry of entries) {
    total += await dirSize(path.join(target, entry.name))
  }
  return total
}

/**
 * Recursively copy a directory, invoking `onBytes` with each file's size as it
 * is copied so the caller can report progress. Symlinked files/folders are
 * copied by content (dumps repacked by archivers occasionally contain them);
 * unreadable entries are skipped rather than failing the whole install.
 */
export async function copyDir(
  src: string,
  dest: string,
  onBytes: (n: number) => void,
  depth = 0
): Promise<void> {
  if (depth > 32) return // link-cycle guard
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(from, to, onBytes, depth + 1)
      continue
    }
    try {
      const followed = await fsp.stat(from) // follows symlinks
      if (followed.isDirectory()) {
        await copyDir(from, to, onBytes, depth + 1)
      } else {
        await fsp.copyFile(from, to)
        onBytes(followed.size)
      }
    } catch {
      // e.g. a broken link inside the dump — skip it, keep installing.
    }
  }
}
