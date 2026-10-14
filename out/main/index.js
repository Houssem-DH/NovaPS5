"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const child_process = require("child_process");
const util = require("util");
function toolsDir() {
  if (electron.app.isPackaged) {
    return path.join(process.resourcesPath, "tools");
  }
  return path.join(electron.app.getAppPath(), "resources", "tools");
}
function relinkerPath() {
  return path.join(toolsDir(), "relinker.exe");
}
function unwrapScriptPath() {
  return path.join(toolsDir(), "unwrap_self.py");
}
function runtimeLibsDir() {
  return path.join(toolsDir(), "libs");
}
function libraryRoot() {
  return path.join(electron.app.getPath("documents"), "PS5 Library");
}
function gamesRoot() {
  return path.join(libraryRoot(), "games");
}
function libraryFile() {
  return path.join(libraryRoot(), "library.json");
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function toolingPresent() {
  const libs = runtimeLibsDir();
  let libsPresent = false;
  try {
    libsPresent = fs.existsSync(libs) && fs.readdirSync(libs).some((f) => f.endsWith(".prx"));
  } catch {
    libsPresent = false;
  }
  return {
    relinker: fs.existsSync(relinkerPath()),
    libs: libsPresent,
    unwrap: fs.existsSync(unwrapScriptPath())
  };
}
let cache = null;
async function load() {
  if (cache) return cache;
  try {
    const raw = await fs.promises.readFile(libraryFile(), "utf8");
    const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
    const parsed = JSON.parse(text);
    cache = { games: Array.isArray(parsed.games) ? parsed.games : [] };
  } catch {
    cache = { games: [] };
  }
  return cache;
}
async function persist() {
  if (!cache) return;
  ensureDir(path.dirname(libraryFile()));
  await fs.promises.writeFile(libraryFile(), JSON.stringify(cache, null, 2), "utf8");
}
function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "game";
}
async function listGames() {
  const data = await load();
  return [...data.games].sort((a, b) => b.installedAt - a.installedAt);
}
async function getGame(id) {
  const data = await load();
  return data.games.find((game) => game.id === id);
}
async function addGame(game) {
  const data = await load();
  const index = data.games.findIndex((g) => g.id === game.id);
  if (index >= 0) data.games[index] = game;
  else data.games.push(game);
  await persist();
}
async function removeGame(id) {
  const data = await load();
  const game = data.games.find((g) => g.id === id);
  data.games = data.games.filter((g) => g.id !== id);
  await persist();
  if (game) {
    await fs.promises.rm(game.installPath, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function touchPlay(id) {
  const data = await load();
  const game = data.games.find((g) => g.id === id);
  if (game) {
    game.lastPlayedAt = Date.now();
    await persist();
  }
}
async function launchGame(id) {
  const game = await getGame(id);
  if (!game) return { ok: false, error: "Game not found in library." };
  try {
    const child = child_process.spawn(game.exePath, [], {
      cwd: game.installPath,
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    await touchPlay(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
const SELF_MAGIC = Buffer.from([79, 21, 61, 29]);
const ELF_MAGIC = Buffer.from([127, 69, 76, 70]);
const PE_MAGIC = Buffer.from([77, 90]);
function detectContainer(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 0);
    if (read < 2) return "unknown";
    if (buf.subarray(0, 4).equals(ELF_MAGIC)) return "elf";
    if (buf.subarray(0, 4).equals(SELF_MAGIC)) return "self";
    if (buf.subarray(0, 2).equals(PE_MAGIC)) return "pe";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    if (fd !== void 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      // On Windows, .py/.exe resolution is more reliable without a shell, but we
      // still avoid shell interpolation entirely (no command-injection surface).
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let timer;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      opts.onOutput?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      opts.onOutput?.(s);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
function extractFailure(output) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fail = lines.find((l) => /^FAIL:/i.test(l));
  if (fail) return fail.replace(/^FAIL:\s*/i, "");
  const last = lines[lines.length - 1];
  return last ?? null;
}
const execFileAsync = util.promisify(child_process.execFile);
let cached;
async function findPython() {
  if (cached !== void 0) return cached;
  const candidates = [
    { cmd: "py", prefixArgs: ["-3"] },
    { cmd: "python", prefixArgs: [] },
    { cmd: "python3", prefixArgs: [] }
  ];
  for (const { cmd, prefixArgs } of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, [...prefixArgs, "--version"], {
        windowsHide: true,
        timeout: 1e4
      });
      const out = `${stdout}${stderr}`;
      if (/Python\s+3\./i.test(out)) {
        cached = prefixArgs.length ? `${cmd} ${prefixArgs.join(" ")}` : cmd;
        return cached;
      }
    } catch {
    }
  }
  cached = null;
  return null;
}
async function unwrapSelf(input, output, verbose = false) {
  const python = await findPython();
  if (!python) {
    throw new Error(
      "Python 3 was not found on this system. Install Python 3 (python.org) so the SELF unwrap step can run."
    );
  }
  const [cmd, ...prefix] = python.split(" ").filter(Boolean);
  const args = [...prefix, unwrapScriptPath(), input, output];
  if (verbose) args.push("--verbose");
  const { code, stdout, stderr } = await run(cmd, args, { timeoutMs: 10 * 60 * 1e3 });
  if (code !== 0) {
    const detail = /not a SELF container/i.test(stderr) ? `${path.basename(input)} is not a SELF container.` : /looks encrypted/i.test(stderr) ? `${path.basename(input)} is still encrypted — dump it decrypted before converting.` : stderr.trim() || stdout.trim() || `exit code ${code}`;
    throw new Error(`Unwrap failed — ${detail}`);
  }
}
async function relink(inputElf, outputExe, onOutput, cwd, moduleDirs = []) {
  const args = ["--windows"];
  for (const dir of moduleDirs) args.push("--module-dir", dir);
  args.push(inputElf, outputExe);
  const { code, stdout, stderr } = await run(
    relinkerPath(),
    args,
    { onOutput, cwd, timeoutMs: 30 * 60 * 1e3 }
  );
  if (code !== 0) {
    const detail = extractFailure(`${stderr}
${stdout}`) ?? `relinker exited with code ${code}`;
    throw new Error(`Conversion failed — ${detail}`);
  }
  return { stdout, stderr };
}
async function dirSize(target) {
  let stat;
  try {
    stat = await fs.promises.lstat(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const entries = await fs.promises.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    total += await dirSize(path.join(target, entry.name));
  }
  return total;
}
async function copyDir(src, dest, onBytes) {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, onBytes);
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(from);
      await fs.promises.copyFile(from, to);
      onBytes(stat.size);
    }
  }
}
async function buildLayout(installDir, keepAtRoot = []) {
  const app0 = path.join(installDir, "app0");
  await fs.promises.mkdir(app0, { recursive: true });
  const exclude = /* @__PURE__ */ new Set([
    "app0",
    // never move the destination into itself
    "libs",
    // recreated below as a junction
    "sce_module",
    // original modules are consumed by the relinker, then deleted
    "eboot.bin",
    // intermediate, deleted after layout
    "input.elf",
    // intermediate, deleted after layout
    ...keepAtRoot
  ]);
  for (const entry of await fs.promises.readdir(installDir, { withFileTypes: true })) {
    if (exclude.has(entry.name) || entry.name.endsWith(".esbak")) continue;
    const src = path.join(installDir, entry.name);
    const dest = path.join(app0, entry.name);
    try {
      await fs.promises.rename(src, dest);
    } catch (error) {
      if (entry.isDirectory() && fs.existsSync(dest)) {
        await mergeDirs(src, dest);
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not move ${entry.name} into app0 — ${detail}`);
      }
    }
  }
  const libsLink = path.join(installDir, "libs");
  try {
    await fs.promises.rm(libsLink, { recursive: true, force: true });
  } catch {
  }
  await fs.promises.symlink(runtimeLibsDir(), libsLink, "junction");
}
async function mergeDirs(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory() && fs.existsSync(d)) {
      await mergeDirs(s, d);
    } else if (fs.existsSync(d)) {
      await fs.promises.rm(s, { recursive: true, force: true });
    } else {
      await fs.promises.rename(s, d);
    }
  }
  await fs.promises.rmdir(src);
}
function looksLikeDump(dir) {
  return fs.existsSync(path.join(dir, "eboot.bin")) || fs.existsSync(path.join(dir, "sce_sys"));
}
async function locateDumpRoot(dir, depth = 0) {
  if (depth > 4) return null;
  if (looksLikeDump(dir)) return dir;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await locateDumpRoot(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}
function parseParamSfo(buffer) {
  const out = {};
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 1179865088) return out;
  const keyTableStart = buffer.readUInt32LE(8);
  const dataTableStart = buffer.readUInt32LE(12);
  const indexCount = buffer.readUInt32LE(16);
  for (let i = 0; i < indexCount; i++) {
    const entry = 20 + i * 16;
    if (entry + 16 > buffer.length) break;
    const keyOffset = buffer.readUInt16LE(entry);
    const dataLen = buffer.readUInt32LE(entry + 4);
    const dataOffset = buffer.readUInt32LE(entry + 12);
    const keyStart = keyTableStart + keyOffset;
    const keyEnd = buffer.indexOf(0, keyStart);
    const dataStart = dataTableStart + dataOffset;
    if (keyEnd < 0 || dataStart + dataLen > buffer.length) continue;
    const key = buffer.toString("utf8", keyStart, keyEnd);
    if (!key) continue;
    out[key] = buffer.toString("utf8", dataStart, dataStart + dataLen).replace(/\0+$/, "");
  }
  return out;
}
async function readMeta(sourceDir) {
  let name = path.basename(sourceDir);
  let titleId = null;
  let hasCover = false;
  try {
    const raw = await fs.promises.readFile(path.join(sourceDir, "sce_sys", "param.json"), "utf8");
    const json = JSON.parse(raw);
    if (typeof json.titleId === "string") titleId = json.titleId;
    const lp = json.localizedParameters;
    if (lp && typeof lp === "object") {
      const lang = typeof lp.defaultLanguage === "string" ? lp.defaultLanguage : "en-US";
      const title = lp[lang]?.titleName ?? lp["en-US"]?.titleName;
      if (typeof title === "string" && title.trim()) name = title.trim();
    }
  } catch {
  }
  if (!titleId || name === path.basename(sourceDir)) {
    try {
      const sfo = parseParamSfo(await fs.promises.readFile(path.join(sourceDir, "sce_sys", "param.sfo")));
      if (!titleId && sfo.TITLE_ID?.trim()) titleId = sfo.TITLE_ID.trim();
      if (name === path.basename(sourceDir) && sfo.TITLE?.trim()) name = sfo.TITLE.trim();
    } catch {
    }
  }
  try {
    await fs.promises.access(path.join(sourceDir, "sce_sys", "icon0.png"));
    hasCover = true;
  } catch {
  }
  return { name, titleId, hasCover };
}
async function extractZip(zip, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  const { code, stderr } = await run("tar", ["-xf", zip, "-C", dest], {
    timeoutMs: 30 * 60 * 1e3
  });
  if (code !== 0) {
    throw new Error(`Could not extract the archive — ${stderr.trim() || `tar exited with code ${code}`}`);
  }
}
async function resolveSource(sourcePath) {
  if (/\.zip$/i.test(sourcePath)) {
    const tempDir = path.join(electron.app.getPath("temp"), `ps5lib-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await extractZip(sourcePath, tempDir);
    const root2 = await locateDumpRoot(tempDir) ?? tempDir;
    return { root: root2, tempDir };
  }
  const root = await locateDumpRoot(sourcePath) ?? sourcePath;
  return { root, tempDir: null };
}
async function detectDump(sourcePath) {
  let tempDir = null;
  try {
    const resolved = await resolveSource(sourcePath);
    tempDir = resolved.tempDir;
    const root = resolved.root;
    if (!fs.existsSync(path.join(root, "eboot.bin"))) {
      return { isDump: false, reason: "No eboot.bin found — this does not look like a PS5 game dump." };
    }
    const meta = await readMeta(root);
    let sizeBytes = 0;
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (entry.name.endsWith(".esbak")) continue;
      sizeBytes += await dirSize(path.join(root, entry.name));
    }
    return { isDump: true, name: meta.name, titleId: meta.titleId, hasCover: meta.hasCover, sizeBytes };
  } catch (error) {
    return { isDump: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
function isBackup(name) {
  return name.endsWith(".esbak");
}
async function installGame(sourcePath, nameOverride, report, jobId) {
  let step = "validating";
  let percent = 0;
  let tempDir = null;
  let createdId = null;
  const emit = (message, pct, s) => {
    step = s;
    percent = Math.round(pct);
    report({ jobId, step, message, percent, status: "running" });
  };
  try {
    emit("Validating source…", 2, "validating");
    const resolved = await resolveSource(sourcePath);
    tempDir = resolved.tempDir;
    const dumpRoot = resolved.root;
    if (!fs.existsSync(path.join(dumpRoot, "eboot.bin"))) {
      throw new Error("No eboot.bin found — this does not look like a PS5 game dump.");
    }
    const meta = await readMeta(dumpRoot);
    const name = (nameOverride?.trim() || meta.name).slice(0, 90);
    const baseId = slugify(name);
    const owned = await getGame(baseId);
    const sameTitle = !!owned && !!meta.titleId && owned.titleId === meta.titleId;
    let id = baseId;
    if (!sameTitle) {
      let n = 2;
      const taken = async (candidate) => !!await getGame(candidate) || fs.existsSync(path.join(gamesRoot(), candidate));
      while (await taken(id)) id = `${baseId}-${n++}`;
    }
    const installDir = path.join(gamesRoot(), id);
    createdId = id;
    await fs.promises.rm(installDir, { recursive: true, force: true });
    ensureDir(installDir);
    const entries = (await fs.promises.readdir(dumpRoot, { withFileTypes: true })).filter(
      (entry) => !isBackup(entry.name)
    );
    let total = 0;
    for (const entry of entries) total += await dirSize(path.join(dumpRoot, entry.name));
    let copied = 0;
    let lastCopyEmit = 0;
    emit("Copying game data…", 8, "copying");
    for (const entry of entries) {
      const src = path.join(dumpRoot, entry.name);
      const dest = path.join(installDir, entry.name);
      const stat = await fs.promises.stat(src);
      const tick = (n) => {
        copied += n;
        const pct = total > 0 ? 8 + Math.min(42, copied / total * 42) : 8;
        const now = Date.now();
        if (pct - percent >= 1 || now - lastCopyEmit > 400) {
          lastCopyEmit = now;
          emit(`Copying ${entry.name}…`, pct, "copying");
        }
      };
      if (entry.isDirectory()) await copyDir(src, dest, tick);
      else if (entry.isFile()) {
        await fs.promises.copyFile(src, dest);
        tick(stat.size);
      }
    }
    const ebootDest = path.join(installDir, "eboot.bin");
    const inputElf = path.join(installDir, "input.elf");
    if (detectContainer(ebootDest) === "self") {
      emit("Unwrapping eboot (SELF → ELF)…", 55, "unwrapping-eboot");
      await unwrapSelf(ebootDest, inputElf);
    } else {
      await fs.promises.copyFile(ebootDest, inputElf);
    }
    emit("Preparing modules…", 60, "preparing-modules");
    const prxDirs = [];
    const moduleDirs = [];
    const scanForModules = async (dir, rel, depth) => {
      if (depth > 4) return;
      let entries2;
      try {
        entries2 = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      let hasPrx = false;
      for (const entry of entries2) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "sce_sys") continue;
          await scanForModules(full, rel ? path.join(rel, entry.name) : entry.name, depth + 1);
        } else if (entry.name.endsWith(".esbak")) {
          await fs.promises.rm(full, { force: true });
        } else if (entry.name.endsWith(".prx")) {
          hasPrx = true;
        }
      }
      if (hasPrx && rel) {
        prxDirs.push(rel);
        if (rel !== "sce_module") moduleDirs.push(rel);
      }
    };
    await scanForModules(installDir, "", 0);
    for (const rel of prxDirs) {
      const dir = path.join(installDir, rel);
      for (const file of await fs.promises.readdir(dir)) {
        if (!file.endsWith(".prx")) continue;
        const filePath = path.join(dir, file);
        if (detectContainer(filePath) === "self") {
          emit(`Unwrapping ${file}…`, 60, "preparing-modules");
          await unwrapSelf(filePath, filePath);
        }
      }
    }
    const modDir = path.join(installDir, "sce_module");
    emit("Converting to a Windows executable…", 68, "relinking");
    const safeName = name.replace(/[\\/:*?"<>|]/g, "").trim() || "game";
    const exePath = path.join(installDir, `${safeName}.exe`);
    await relink(inputElf, exePath, void 0, installDir, moduleDirs);
    for (const rel of prxDirs) {
      const dir = path.join(installDir, rel);
      for (const file of await fs.promises.readdir(dir).catch(() => [])) {
        if (file.endsWith(".prx") && !file.endsWith(".guest.prx")) {
          await fs.promises.rm(path.join(dir, file), { force: true });
        }
      }
    }
    emit("Building runtime layout…", 88, "building-layout");
    await buildLayout(installDir, [path.basename(exePath), "cover.png"]);
    let cover = null;
    try {
      await fs.promises.copyFile(
        path.join(installDir, "app0", "sce_sys", "icon0.png"),
        path.join(installDir, "cover.png")
      );
      cover = "cover.png";
    } catch {
    }
    emit("Finalizing…", 95, "finalizing");
    await fs.promises.rm(ebootDest, { force: true });
    await fs.promises.rm(inputElf, { force: true });
    await fs.promises.rm(modDir, { recursive: true, force: true });
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
      });
      tempDir = null;
    }
    const sizeBytes = await dirSize(installDir);
    const game = {
      id,
      name,
      titleId: meta.titleId,
      sourcePath: dumpRoot,
      installPath: installDir,
      exePath,
      sizeBytes,
      cover,
      status: "ready",
      installedAt: Date.now()
    };
    await addGame(game);
    report({ jobId, step: "done", message: "Ready to play", percent: 100, status: "done", gameId: id, gameName: name });
    return game;
  } catch (error) {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
    });
    if (createdId) {
      await removeGame(createdId).catch(() => {
      });
      await fs.promises.rm(path.join(gamesRoot(), createdId), { recursive: true, force: true }).catch(() => {
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    report({ jobId, step, message: "Failed", percent, status: "error", error: message });
    throw error;
  }
}
async function appInfo() {
  const { relinker, libs } = toolingPresent();
  return {
    toolsDir: toolsDir(),
    relinkerPresent: relinker,
    libsPresent: libs,
    pythonPath: await findPython(),
    libraryRoot: libraryRoot()
  };
}
function registerIpc(getWindow) {
  electron.ipcMain.handle("app:info", () => appInfo());
  electron.ipcMain.handle("dialog:selectFolder", async () => {
    const win = getWindow();
    const options = { properties: ["openDirectory", "createDirectory"] };
    const result = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });
  electron.ipcMain.handle("dialog:selectZip", async () => {
    const win = getWindow();
    const options = {
      properties: ["openFile"],
      filters: [{ name: "PS5 dump archive", extensions: ["zip"] }]
    };
    const result = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });
  electron.ipcMain.handle("library:detect", (_e, sourcePath) => detectDump(sourcePath));
  electron.ipcMain.handle("library:list", () => listGames());
  electron.ipcMain.handle("game:launch", (_e, id) => launchGame(id));
  electron.ipcMain.handle("game:remove", async (_e, id) => {
    await removeGame(id);
    return { ok: true };
  });
  electron.ipcMain.handle("install:start", (_e, req) => {
    const jobId = crypto.randomUUID();
    installGame(req.sourcePath, req.name, (progress) => {
      getWindow()?.webContents.send("install:progress", progress);
    }, jobId).catch(() => {
    });
    return { jobId };
  });
}
electron.protocol.registerSchemesAsPrivileged([
  { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
let mainWindow = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: "#09090b",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#09090b", symbolColor: "#a1a1aa", height: 40 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
electron.app.whenReady().then(() => {
  electron.protocol.handle("media", (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const root = gamesRoot();
      const full = path.resolve(root, rel);
      if (!full.startsWith(root)) return new Response("forbidden", { status: 403 });
      const data = fs.readFileSync(full);
      const ext = path.extname(full).toLowerCase();
      const type = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
      return new Response(new Uint8Array(data), { headers: { "Content-Type": type } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  ensureDir(gamesRoot());
  registerIpc(() => mainWindow);
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
