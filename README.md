# NovaPS5

A desktop library, converter and launcher for PS5 game dumps on Windows — **by Nova Crafted**.

Point it at a dump folder (or a `.zip` / `.rar` / `.7z` / `.tar` archive), and NovaPS5 drives the conversion, installs
the game, then **launches it once to tell you whether it works**. No command line, no manual tooling.

![NovaPS5 library](public/logo.png)

> ### Credit where it is due
>
> **The conversion engine is [AnyPS5](https://github.com/boykopovar/AnyPS5), by
> [@boykopovar](https://github.com/boykopovar) — it is the real work, and it is not ours.**
>
> AnyPS5 implements the hard part of PS5 executables on desktop: decrypting/unwrapping SELF and fSELF
> containers to ELF, relinking the imports of the converted ELF, and shipping the runtime libraries the
> converted executable needs. NovaPS5 is the layer around it: a desktop library, the dump validation and
> install pipeline, the archive handling, the preflight compatibility report, the install once-and-verify
> launch test, per-game organisation, self-updating and packaging. Everything that actually makes a PS5
> binary run on Windows comes from AnyPS5 and is redistributed here under its GPL-2.0 license.
>
> NovaPS5 ships `scripts/unwrap_self.py` (taken from AnyPS5) and the AnyPS5 relinker + runtime libraries,
> and refreshes them from AnyPS5's releases. If any of it is useful to you, please star and support the
> upstream project.

---

## Features

- **Installs every convertible dump.** Duplicate modules, both `sce_module/` and `sce_modules/`,
  leftover `*.bak*` files, symlinked or odd archive entries and `.rar` / `.7z` sources are all handled
  automatically — the installer never destroys a working install (stage-then-swap).
- **Loader stand-in libraries are left alone.** `fakelib`-style folders ship fake copies of the console's
  system libraries for other loaders. They are skipped instead of converted: the runtime provides the
  real implementations, and relinking the stubs makes the generated entry point abort on imports the
  runtime does not export (`GetLastError: 127`).
- **Preflight before install.** The eboot is trial-unwrapped ahead of time, so encrypted or truncated
  dumps are flagged with a plain reason *before* anything is copied; missing runtime libraries are
  predicted too.
- **Works / Not working verdict.** After installing, the game is launched once, watched for 10 seconds
  with a crash log, and marked **✓ Works** or **✗ Not working** with a readable reason
  (e.g. `crashed (0xC0000409 — stack buffer overrun / fail-fast)`). Verified games keep running.
- **Library scan.** Missed installs on disk are adopted, vanished folders are flagged — no restart needed.
- **Custom games folder.** Change it in Settings and every installed game is relocated safely.
- **Runtime updates.** The conversion runtime is fetched from AnyPS5 releases and refreshed
  automatically; Settings shows *Up to date* with an on-demand **Scan for updates**.
- **Python is bundled.** End users never install Python — the interpreter ships inside the app.
- **Updates itself — but only when you say so.** The header shows the update state and checks GitHub on
  every launch. A newer release downloads in the background and then waits: nothing installs on its own,
  not even when you quit the app. Click **Restart to update** (header, dialog or Settings) whenever it
  suits you; NovaPS5 installs the update, restarts and opens a **What's new** dialog with the release
  notes you published.

## Requirements

- Windows 10/11 (x64)
- That's it. The app bundles Python, downloads the AnyPS5 runtime on first launch, and installs
  per-user (no admin prompt).

## Using it

1. Run the installer and launch **NovaPS5** (first launch prepares the conversion runtime).
2. **Install game** → pick a dump folder or archive → review the compatibility report → **Install**.
3. When it finishes you get the launch-test verdict, then hit **Play**.

Games are installed into the folder shown under **Settings ▸ Storage** (changeable at any time).

## Building

```bash
npm install
npm run dev          # development
npm run dist         # Windows installer  -> release/NovaPS5-Setup-<version>.exe
npm run dist:dir     # unpacked app       -> release/win-unpacked/NovaPS5.exe
```

`npm run dist` first downloads the embeddable Python runtime (`npm run setup:python`) so the installed
app is self-contained, then packages `resources/tools` (relinker + libs) and the Python runtime next to
the executable.

> **Windows toolchain note:** electron-builder unpacks its `winCodeSign` tool cache with symbolic links,
> which Windows only permits in Developer Mode or from an elevated shell. `npm run dist` prepares that
> cache itself — the macOS-only payload that uses symlinks is excluded, since Windows never needs it —
> so the build runs from a normal terminal and still stamps the NovaPS5 icon, product name and version
> onto the exe and installer.

Icon/branding assets: `public/icon.png` (app icon) and `public/logo.png` (wordmark). Regenerate the
Windows icon after changing them with `powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1`.

## Releasing an update

The app updates itself from this repository's **GitHub Releases** (see `build.publish` in
`package.json`). To ship a version:

1. **Bump the version** in `package.json` (`0.1.0` → `0.2.0`) and commit it.
2. Run `npm run dist` — this builds `release/NovaPS5-Setup-<version>.exe` and prints the exact files to
   attach.
3. Draft a new release on [github.com/Houssem-DH/NovaPS5/releases](https://github.com/Houssem-DH/NovaPS5/releases)
   with the tag `v<version>` (matching `package.json` exactly) and **attach three files** from `release/`:

   | File | Why it is needed |
   | --- | --- |
   | `NovaPS5-Setup-<version>.exe` | the installer the app runs to update |
   | `latest.yml` | what the updater reads first (version + file name + hash) |
   | `NovaPS5-Setup-<version>.exe.blockmap` | lets the updater download only the changed parts |

4. Write the **release notes in Markdown** — headings, lists, `**bold**`, `` `code` ``, quotes and links
   are all rendered in the in-app What's new dialog. GitHub stores the body as Markdown and the updater
   reads it back already rendered as HTML, so both are handled; a plain-text body is treated as Markdown.
   Notes are kept with the code under `docs/releases/` (see `docs/releases/v0.1.0.md`) so the body can be
   pasted straight into the release.

   ```markdown
   ## Highlights
   - Preflight now warns before a bad dump is installed
   - Installs use a stage-then-swap layout

   ### Fixes
   1. Games that crash at startup report their exit code
   ```

5. Publish the release. Existing installs pick it up on their next launch (or from the header control
   / **Settings ▸ Application updates**), download it in the background, then **wait**. The update only
   installs when the user clicks **Restart to update** — nothing restarts on its own, and quitting the
   app leaves the downloaded update for the next explicit click.

Notes:

- A git **tag alone is not enough** — electron-updater looks for the published release and its
  `latest.yml`. Nothing to attach means the check reports *Release is incomplete*.
- To exercise the real check from a source build, set `NOVAPS5_DEV_UPDATES=1` before `npm run dev`
  (it reads `dev-app-update.yml`). Without it, source builds report that checks are for installed builds.
- Update state lives in `updates.json` under the app's user-data folder (`%APPDATA%\NovaPS5`).
- `autoInstallOnAppQuit` is deliberately off, so a quit never installs a pending update behind the
  user's back.

## How an install works

```
validate → copy to staging → unwrap eboot (SELF → ELF) → unwrap modules → relink (AnyPS5)
        → build app0/ runtime layout → swap into place → launch test → Works / Not working
```

- Everything is prepared in `.staging-<id>-<ts>` and swapped in with an `.old` rollback, so a failure
  never leaves a broken install behind.
- The steps in the middle are **AnyPS5's work**: `scripts/unwrap_self.py` (from AnyPS5) turns a
  decrypted SELF container into a clean ELF using the bundled Python, then the AnyPS5 relinker resolves
  the imports and the AnyPS5 runtime libraries are laid out so the executable starts. NovaPS5 decides
  *what* to convert, prepares the dump so it can be converted, and reports whether the result runs.
- Conversion is local: nothing is uploaded. The only downloads NovaPS5 performs are app/runtime
  updates and archives you explicitly point it at in the Games catalog (see below).

## Games catalog

The **Games** tab browses the public PlayStation Store catalog for metadata — cover art, publisher,
release date and genres — and lets you save games to a catalog library. It does **not** show prices
and does **not** download game content from Sony or any third-party game source.

Installing is driven by files you supply:

- **Self-hosted catalog** — point *Catalog settings* at a JSON catalog you control (see
  [`docs/store-catalog.md`](docs/store-catalog.md)). Its entries appear first in the catalog and can
  be downloaded and converted in one click.
- **Attach a URL** — paste a direct URL to an archive you host on a game's detail page.
- **Local install** — pick a dump folder or a `.zip`/`.rar`/`.7z`/`.tar` archive from disk.

Downloads stream to `<libraryRoot>/downloads`, are optionally verified against a SHA-256 checksum,
then go through the same convert/install pipeline as a manual install. Catalog state (region, catalog
URL and your saved entries) lives in `<libraryRoot>/store.json`.

### Graphics & launch settings

Every installed game has a **Graphics & launch** panel in its library detail page (and in the games
catalog dialog). NovaPS5 saves the settings per game and applies them to the game process before it
starts:

- **VSync** — one click on/off. Off uses `immediate`; the advanced selector also exposes FIFO
  latest ready and mailbox (`ANYPS5_PRESENT_MODE`). Present mode changes latency and tearing, not
  the frame-rate ceiling: AnyPS5 still paces flips at 59.94 Hz unless the title requests its
  119.88 Hz output mode.
- **Vulkan GPU** — leave empty for the first usable device, or name part of a device
  (`ANYPS5_GPU`).
- **Performance overlay** — FPS, frame time, graph, draw calls, memory and render/window
  resolution, with a corner choice (`ANYPS5_OVERLAY`, `ANYPS5_OVERLAY_POS`).
- **GPU / driver timing** — opt-in overlay lines backed by AnyPS5 profiling
  (`APS5_PROFILE_GPU`, `APS5_PROFILE_DRAW`). They add overhead, so the overlay marks a profiled
  run and its numbers are not comparable with a normal one.
- **Session monitor** — records `videoout.jsonl` locally in a per-launch telemetry folder
  (`APS5_VIDEOOUT_TELEMETRY_DIR`) and shows a live FPS chart, average, 1% low and sample count in
  the panel, including the last run after the game exits. NovaPS5 reads only the FPS lines, and
  explains a stable 60/30 FPS plateau instead of offering a fake unlock.
- **Shader cache** — keep or disable the shader/pipeline cache (`ANYPS5_NO_SHADER_CACHE`), and clear
  it if a driver update leaves stale pipelines.

#### Why some games stop at ~60 FPS

AnyPS5 has two vblank/flip clocks: **59.94 Hz** by default and **119.88 Hz** when a title asks for
its high-frame-rate output mode. The runtime only lets a title ask when both conditions hold:

1. the display showing the game is running at **120 Hz or faster**, and
2. the title's `app0/sce_sys/param.json` sets **`attribute3` bit `0x40`**, the 120 Hz output flag.

If either condition is missing, flips stay paced at 59.94 Hz in every present mode. A game can also
hold 60 or 30 FPS on its own (quality/performance mode, internal cap), even on the 120 Hz path.
NovaPS5 reads the display refresh and the game's `attribute3` flag and shows the reason in the
Graphics & launch panel and the session monitor. It does not patch game metadata or force the
119.88 Hz clock: either would bypass a limit the title itself declares and is not a safe "FPS
unlock".

AnyPS5 0.1.3 renders at the resolution the game chooses and does not expose a render-resolution
override, FSR, DLSS, a quality preset, a startup window mode, or a refresh-rate override. NovaPS5
does not fake those controls: use the game's own display/quality menu for resolution and upscaling,
change the refresh rate in Windows display settings, and press **F11** in-game for AnyPS5's
borderless desktop fullscreen. A 120 Hz-or-faster display lets the runtime use its 119.88 Hz output
path, but the game must also advertise 120 Hz output and still decides its own frame rate.

Only fetch archives you have the right to use — dumps of games you own.

#### Why a game can crash right after it starts

Some titles walk the trophy list by calling `sceNpTrophy2GetTrophyInfo` for 0, 1, 2, … and stop when
the runtime reports the invalid trophy id. On the console that call returns `0x8055390A`
(`SCE_NP_TROPHY2_ERROR_INVALID_TROPHY_ID`). AnyPS5 0.1.3 instead throws an uncaught
`std::invalid_argument` when the id is not in the title's `app0/sce_sys/trophy2/trophyNN.ucp`
package, which aborts the guest process with `0xC0000409` in `ucrtbase.dll` within the first second.

The **Compatibility** panel offers **Compatibility placeholders**: NovaPS5 renames the `.ucp`
package to `.ucp.disabled` (the file is kept on disk) and the runtime's own fallback answers every
trophy request with placeholder data and success, so the game runs. Trophy names, descriptions and
the platinum rule are unavailable until you switch back to **Game's package**. New installs that hit
this abort during the post-install launch test are retried once with the package hidden, and the
mode is saved with the game.

## Credits

| Project | Author | What it does here | License |
| --- | --- | --- | --- |
| [**AnyPS5**](https://github.com/boykopovar/AnyPS5) | [@boykopovar](https://github.com/boykopovar) | **The conversion engine.** SELF/fSELF unwrapping, ELF relinking, runtime libraries, and the update feed NovaPS5 pulls the runtime from. | GPL-2.0 |
| [Electron](https://www.electronjs.org/) | OpenJS Foundation | Desktop shell | MIT |
| [React](https://react.dev/), [Vite](https://vite.dev/), [Tailwind CSS](https://tailwindcss.com/), [Radix UI](https://www.radix-ui.com/), [lucide](https://lucide.dev/) | their authors | User interface | MIT / ISC |
| [electron-updater](https://www.electron.build/auto-update) | electron-builder | In-app updates | MIT |
| [CPython](https://www.python.org/) | Python Software Foundation | Runs AnyPS5's unwrap script inside the app | PSF-2.0 |

NovaPS5's own contribution — the library UI, the import/validate/install pipeline, the compatibility
preflight, the launch-test verdict, the updater and the packaging — is by **Nova Crafted**.

## License

NovaPS5 is released under the **GNU General Public License v2.0 or later** — see [`LICENSE`](LICENSE).

It is not a free choice: NovaPS5 redistributes tooling from [AnyPS5](https://github.com/boykopovar/AnyPS5),
which is licensed GPL-2.0 (its unwrap script and the relinker + runtime libraries it ships and updates
from AnyPS5's releases). A program that includes GPL-2.0 code must itself be distributed under the GPL,
so the same terms cover this project, and the full corresponding source is in this repository.

If you fork NovaPS5 or ship a build, keep the license, keep the credits above, and point your users at
[AnyPS5](https://github.com/boykopovar/AnyPS5) for the engine.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main` | Electron main process: window, menu, IPC, library, updater, settings |
| `src/main/pipeline` | Conversion pipeline (`dump`, `compat`, `install`, `verify`, `relink`, `elf`) |
| `src/main/store` | Games catalog (PS Store metadata), self-hosted catalog, persistence, download/install |
| `src/preload` | `contextBridge` API exposed to the renderer |
| `src/renderer` | React UI (library, games catalog, detail, settings, install dialog, bootstrap) |
| `src/shared` | Types shared across processes |
| `scripts` | Runtime/python setup, icon generation, dist wrapper, AnyPS5's `unwrap_self.py` |
| `public` | Brand assets (`icon.png`, `logo.png`, `favicon.ico`) |
| `build` | Installer/exe icon + the icon generator script |
| `docs` | Release notes and the self-hosted catalog format |
| `resources/store` | Example self-hosted catalog |

## Notes

- Use dumps of games you own. NovaPS5 is a local converter — the Games catalog only reads metadata
  from the PlayStation Store; installs come from archives or dumps you supply.
- Closing the window keeps NovaPS5 running in the tray (click the tray icon to bring it back); quit
  from the tray menu or with `Ctrl+Q`.
- Text is selectable everywhere it is useful (paths, verdicts, release notes) — `Ctrl+C`, right-click →
  Copy, or `Ctrl+A`.
- The conversion runtime (relinker + libraries) comes from the
  [AnyPS5 releases](https://github.com/boykopovar/AnyPS5/releases) and can be updated from Settings.
