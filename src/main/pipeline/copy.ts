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
 * is copied so the caller can report progress. Symlinks in the source are
 * skipped (a dump should not contain any, and following them is unsafe).
 */
export async function copyDir(
  src: string,
  dest: string,
  onBytes: (n: number) => void
): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(from, to, onBytes)
    } else if (entry.isFile()) {
      const stat = await fsp.stat(from)
      await fsp.copyFile(from, to)
      onBytes(stat.size)
    }
  }
}
