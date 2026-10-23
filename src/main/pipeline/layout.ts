import { promises as fsp } from 'fs'
import fs from 'fs'
import path from 'path'
import { runtimeLibsDir } from '../paths'

/**
 * Arrange the installed folder into the layout the AnyPS5 runtime expects.
 *
 *   <installDir>/
 *     <Game>.exe          (relinker output, stays at root)
 *     cover.png           (stays at root)
 *     libs  -> junction to the shared runtime libraries
 *     app0/
 *       sce_module/       (relinker output: *.guest.prx — never overwritten)
 *       <everything else from the dump, moved as-is>
 *       data/ sce_sys/ args.txt images/ *.js ...
 *
 * The runtime resolves /app0/ to <process cwd>/app0, and the game is launched
 * with cwd = <installDir>, so ALL dump content must sit under app0. Dumps vary
 * in layout (data/ vs root-level game files), so this moves the whole tree
 * rather than a fixed list.
 *
 * @param keepAtRoot filenames (not folders) that must remain next to the exe.
 */
export async function buildLayout(installDir: string, keepAtRoot: string[] = []): Promise<void> {
  const app0 = path.join(installDir, 'app0')
  await fsp.mkdir(app0, { recursive: true })

  const exclude = new Set([
    'app0', // never move the destination into itself
    'libs', // recreated below as a junction
    'sce_module', // original modules are consumed by the relinker, then deleted
    'eboot.bin', // intermediate, deleted after layout
    'input.elf', // intermediate, deleted after layout
    ...keepAtRoot
  ])

  for (const entry of await fsp.readdir(installDir, { withFileTypes: true })) {
    if (exclude.has(entry.name) || entry.name.endsWith('.esbak')) continue

    const src = path.join(installDir, entry.name)
    const dest = path.join(app0, entry.name)
    try {
      // Same volume — instant rename, even for multi-GB folders.
      await fsp.rename(src, dest)
    } catch (error) {
      // The relinker may have already created this destination (app0/Media/…
      // for --module-dir output); Windows cannot rename onto an existing
      // directory, so merge its entries instead of failing.
      if (entry.isDirectory() && fs.existsSync(dest)) {
        await mergeDirs(src, dest)
      } else {
        // A silently skipped file means a broken game, so surface it.
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not move ${entry.name} into app0 — ${detail}`)
      }
    }
  }

  // Junction libs -> the shared runtime libraries (instant, no data copied, so
  // every installed game points at one copy of the system .prx files).
  const libsSource = runtimeLibsDir()
  try {
    if (!(await fsp.stat(libsSource)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(
      'The shared runtime libraries are missing — repair or reinstall the conversion runtime, then retry.'
    )
  }
  const libsLink = path.join(installDir, 'libs')
  try {
    await fsp.rm(libsLink, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    await fsp.symlink(libsSource, libsLink, 'junction')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // Junctions need a local volume; a network/removable share or a read-only
    // folder fails here after the whole game has already been copied.
    throw new Error(
      `Could not link the runtime libraries into the install — ${detail}. Make sure the games folder is on a local, writable drive and retry.`
    )
  }
}

/** Move src's entries into the already existing dest directory, then remove src. */
async function mergeDirs(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory() && fs.existsSync(d)) {
      await mergeDirs(s, d)
    } else if (fs.existsSync(d)) {
      // Same name in both places: keep the relinker's output, drop the dump copy.
      await fsp.rm(s, { recursive: true, force: true })
    } else {
      await fsp.rename(s, d)
    }
  }
  await fsp.rmdir(src)
}
