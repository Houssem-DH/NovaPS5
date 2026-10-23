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
 * broken links are skipped, but a locked or unreadable file fails with the
 * exact path instead of silently producing a broken install.
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
    // Antivirus/indexers can hold a freshly extracted file open for a moment;
    // retry a couple of times before giving up with the exact path.
    for (let attempt = 0; ; attempt++) {
      try {
        const followed = await fsp.stat(from) // follows symlinks
        if (followed.isDirectory()) {
          await copyDir(from, to, onBytes, depth + 1)
        } else {
          await fsp.copyFile(from, to)
          onBytes(followed.size)
        }
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // Broken links / entries that vanished mid-copy are harmless.
        if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') break
        if (attempt < 2 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
          continue
        }
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not copy "${from}" — ${detail}`)
      }
    }
  }
}
