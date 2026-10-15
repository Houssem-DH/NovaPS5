"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const child_process = require("child_process");
const util = require("util");
const DEFAULT_RUNTIME_REPO = "boykopovar/AnyPS5";
let toolsOverride = null;
function setToolsOverride(dir) {
  toolsOverride = dir;
}
function toolsDir() {
  if (toolsOverride) return toolsOverride;
  if (electron.app.isPackaged) {
    const installed = path.join(process.resourcesPath, "tools");
    if (fs.existsSync(installed) && isWritableDir(installed)) return installed;
    return path.join(electron.app.getPath("userData"), "tools");
  }
  return path.join(electron.app.getAppPath(), "resources", "tools");
}
function relinkerPath() {
  return path.join(toolsDir(), "relinker.exe");
}
function unwrapScriptPath() {
  return path.join(toolsDir(), "unwrap_self.py");
}
function unwrapSourcePath() {
  return path.join(electron.app.getAppPath(), "scripts", "unwrap_self.py");
}
function runtimeLibsDir() {
  return path.join(toolsDir(), "libs");
}
function libraryRoot() {
  const docs = electron.app.getPath("documents");
  const legacy = path.join(docs, "PS5 Library");
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch {
  }
  return path.join(docs, "NovaPS5 Library");
}
function configFile() {
  return path.join(libraryRoot(), "config.json");
}
let configCache = null;
function loadConfig() {
  if (configCache) return configCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    configCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    configCache = {};
  }
  return configCache;
}
function saveConfig(cfg) {
  configCache = cfg;
  ensureDir(libraryRoot());
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), "utf8");
}
function gamesRoot() {
  const custom = loadConfig().gamesDir;
  if (custom) return custom;
  return path.join(libraryRoot(), "games");
}
function runtimeRepo() {
  return loadConfig().runtimeRepo || DEFAULT_RUNTIME_REPO;
}
function libraryFile() {
  return path.join(libraryRoot(), "library.json");
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function isWritableDir(dir) {
  try {
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
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
async function relocateGames(updates) {
  const data = await load();
  for (const update of updates) {
    const game = data.games.find((g) => g.id === update.id);
    if (game) {
      game.installPath = update.installPath;
      game.exePath = update.exePath;
    }
  }
  await persist();
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
const execFileAsync$2 = util.promisify(child_process.execFile);
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
      const { stdout, stderr } = await execFileAsync$2(cmd, [...prefixArgs, "--version"], {
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
async function extractZip$1(zip, dest) {
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
    await extractZip$1(sourcePath, tempDir);
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
const activeStages = /* @__PURE__ */ new Set();
async function installGame(sourcePath, nameOverride, report, jobId) {
  let step = "validating";
  let percent = 0;
  let tempDir = null;
  let stageDir = null;
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
    const finalDir = path.join(gamesRoot(), id);
    const stageName = `.staging-${id}-${Date.now()}`;
    const installDir = path.join(gamesRoot(), stageName);
    stageDir = installDir;
    activeStages.add(stageName);
    for (const entry of await fs.promises.readdir(gamesRoot()).catch(() => [])) {
      if (entry.startsWith(".staging-") && !activeStages.has(entry)) {
        await fs.promises.rm(path.join(gamesRoot(), entry), { recursive: true, force: true }).catch(() => {
        });
      }
    }
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
    const ebootKind = detectContainer(ebootDest);
    if (ebootKind === "self") {
      emit("Unwrapping eboot (SELF → ELF)…", 55, "unwrapping-eboot");
      await unwrapSelf(ebootDest, inputElf);
    } else if (ebootKind === "elf") {
      await fs.promises.copyFile(ebootDest, inputElf);
    } else {
      throw new Error(
        "eboot.bin is neither a plain ELF nor a SELF container — the dump file is corrupted or incomplete."
      );
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
        const kind = detectContainer(filePath);
        if (kind === "self") {
          emit(`Unwrapping ${file}…`, 60, "preparing-modules");
          await unwrapSelf(filePath, filePath);
        } else if (kind !== "elf") {
          throw new Error(
            `${path.join(rel, file)} is neither a plain ELF nor a SELF container — the dump's module is corrupted or incomplete.`
          );
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
    const retire = `${finalDir}.old`;
    await fs.promises.rm(retire, { recursive: true, force: true }).catch(() => {
    });
    if (fs.existsSync(finalDir)) {
      await fs.promises.rename(finalDir, retire);
    }
    try {
      await fs.promises.rename(installDir, finalDir);
    } catch (swapError) {
      if (fs.existsSync(retire)) await fs.promises.rename(retire, finalDir).catch(() => {
      });
      throw swapError;
    }
    await fs.promises.rm(retire, { recursive: true, force: true }).catch(() => {
    });
    activeStages.delete(stageName);
    stageDir = null;
    const sizeBytes = await dirSize(finalDir);
    const game = {
      id,
      name,
      titleId: meta.titleId,
      sourcePath: dumpRoot,
      installPath: finalDir,
      exePath: path.join(finalDir, path.basename(exePath)),
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
    if (stageDir) {
      activeStages.delete(path.basename(stageDir));
      await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    report({ jobId, step, message: "Failed", percent, status: "error", error: message });
    throw error;
  }
}
const execFileAsync$1 = util.promisify(child_process.execFile);
const RUNTIME_ASSET = "novaps5-runtime-win-x64.zip";
const MANIFEST_NAME = "runtime.json";
let running = null;
function readRuntimeManifest(dir = toolsDir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf8"));
    if (parsed && typeof parsed.version === "string") return parsed;
  } catch {
  }
  return null;
}
function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");
}
function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function normalizeVersion(tag) {
  const flat = tag.replace(/^runtime[-v]*/i, "").replace(/^v/i, "");
  return flat || tag;
}
function requestBuffer(url, headers, timeoutMs, redirect = 0) {
  return new Promise((resolve, reject) => {
    const request = electron.net.request(url);
    for (const [key, value] of Object.entries(headers)) request.setHeader(key, value);
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error("timed out"));
    }, timeoutMs);
    const chunks = [];
    request.on("response", (response) => {
      const rawLocation = response.headers["location"];
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        clearTimeout(timer);
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && location) {
          if (redirect >= 5) return reject(new Error("too many redirects"));
          resolve(requestBuffer(new URL(location, url).toString(), headers, timeoutMs, redirect + 1));
          return;
        }
        resolve({ status, body: Buffer.concat(chunks) });
      });
      response.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    request.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}
async function fetchHtml(url) {
  const response = await requestBuffer(
    url,
    {
      "User-Agent": "NovaPS5",
      Accept: "text/html,application/xhtml+xml",
      // deterministic body — some middleboxes gzip regardless of support
      "Accept-Encoding": "identity"
    },
    2e4
  );
  if (response.status === 404) return "";
  if (response.status !== 200) throw new Error(`GitHub returned HTTP ${response.status}`);
  return response.body.toString("utf8");
}
function parseAssets(repo, html) {
  const out = [];
  const parts = html.split("/releases/download/");
  for (let i = 1; i < parts.length; i++) {
    const match = parts[i].match(/^([^/"]+)\/([^"?]+)"/);
    if (!match) continue;
    const sha = parts[i].match(/sha256:([0-9a-f]{64})/i);
    out.push({
      name: decodeURIComponent(match[2]),
      url: `https://github.com/${repo}/releases/download/${match[1]}/${match[2]}`,
      sha256: sha ? sha[1].toLowerCase() : null
    });
  }
  return out;
}
async function findLatestRuntime(repo) {
  const listHtml = await fetchHtml(`https://github.com/${repo}/releases`);
  if (!listHtml) return null;
  const tagMatch = listHtml.match(/\/releases\/tag\/([^"'?#<\s]+)/);
  if (!tagMatch) return null;
  const tag = decodeURIComponent(tagMatch[1]);
  const assets = parseAssets(repo, await fetchHtml(`https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`));
  return {
    version: normalizeVersion(tag),
    tag,
    prx: assets.find((a) => /^prx-windows-.+\.zip$/i.test(a.name)),
    relinker: assets.find((a) => /^relinker-.+\.exe$/i.test(a.name)),
    bundle: assets.find((a) => a.name === RUNTIME_ASSET)
  };
}
function downloadFile(url, dest, onPercent, redirect = 0) {
  return new Promise((resolve, reject) => {
    const request = electron.net.request(url);
    request.setHeader("User-Agent", "NovaPS5");
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      request.abort();
      finish(new Error("download timed out"));
    }, 15 * 6e4);
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      const rawLocation = response.headers["location"];
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        clearTimeout(timer);
        if (redirect >= 5) return finish(new Error("too many redirects"));
        downloadFile(new URL(location, url).toString(), dest, onPercent, redirect + 1).then(
          () => finish(),
          (err) => finish(err)
        );
        return;
      }
      if (status !== 200) {
        response.resume();
        clearTimeout(timer);
        return finish(new Error(`download failed (HTTP ${status})`));
      }
      const rawLength = response.headers["content-length"];
      const total = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength ?? 0);
      let received = 0;
      let lastPct = -1;
      const out = fs.createWriteStream(dest);
      out.on("error", (err) => {
        clearTimeout(timer);
        finish(err);
      });
      response.on("data", (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.min(99, Math.floor(received * 100 / total));
          if (pct !== lastPct) {
            lastPct = pct;
            onPercent(pct);
          }
        }
      });
      response.on("end", () => {
        out.end(() => {
          clearTimeout(timer);
          onPercent(100);
          finish();
        });
      });
      response.on("error", (err) => {
        clearTimeout(timer);
        finish(err);
      });
      response.pipe(out);
    });
    request.on("error", (err) => {
      clearTimeout(timer);
      finish(err instanceof Error ? err : new Error(String(err)));
    });
    request.end();
  });
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
async function downloadAsset(asset, dest, label, emit, detail) {
  await downloadFile(asset.url, dest, (percent) => {
    emit({ id: "download", label, status: "active", percent, detail });
  });
  if (asset.sha256) {
    const actual = await sha256File(dest);
    if (actual !== asset.sha256) throw new Error(`checksum mismatch for ${asset.name}`);
  }
}
async function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  const esc = (p) => p.replace(/'/g, "''");
  await execFileAsync$1(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(destDir)}' -Force`
    ],
    { windowsHide: true }
  );
}
function looksLikeRuntime(dir) {
  try {
    const libs = path.join(dir, "libs");
    const hasLibs = fs.existsSync(libs) && fs.readdirSync(libs).some((f) => f.endsWith(".prx"));
    return fs.existsSync(path.join(dir, "relinker.exe")) && hasLibs;
  } catch {
    return false;
  }
}
function ensureUnwrapScript(targetDir) {
  try {
    const dest = path.join(targetDir, "unwrap_self.py");
    const source = unwrapSourcePath();
    if (!fs.existsSync(source)) return;
    const incoming = fs.readFileSync(source);
    let current = null;
    try {
      current = fs.readFileSync(dest);
    } catch {
      current = null;
    }
    if (current && current.equals(incoming)) return;
    fs.writeFileSync(dest, incoming);
  } catch {
  }
}
function installTarget() {
  const current = toolsDir();
  try {
    ensureDir(current);
    const probe = path.join(current, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return current;
  } catch {
    const fallback = path.join(electron.app.getPath("userData"), "tools");
    setToolsOverride(fallback);
    ensureDir(fallback);
    return fallback;
  }
}
function swapIn(stageDir, target) {
  const backup = `${target}.old`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(target)) {
    fs.renameSync(target, backup);
    try {
      fs.renameSync(stageDir, target);
    } catch (err) {
      fs.renameSync(backup, target);
      throw err;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } else {
    fs.renameSync(stageDir, target);
  }
}
async function ensureRuntimeOnce(emit) {
  const step = (s) => emit(s);
  const fail = (id, label, error) => {
    const message = error instanceof Error ? error.message : String(error);
    step({ id, label, status: "error", detail: message });
    return { ok: false, runtimeVersion: readRuntimeManifest()?.version ?? null, updated: false, error: message };
  };
  const ready = (runtimeVersion, updated) => {
    step({ id: "ready", label: "Ready", status: "done", detail: updated ? "Runtime installed" : void 0 });
    return { ok: true, runtimeVersion, updated };
  };
  const target = installTarget();
  ensureUnwrapScript(target);
  const checkLabel = "Checking for runtime updates";
  step({ id: "check", label: checkLabel, status: "active" });
  const present = toolingPresent();
  const toolsReady = present.relinker && present.libs;
  const manifest = readRuntimeManifest(target);
  let release = null;
  try {
    release = await findLatestRuntime(runtimeRepo());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (toolsReady) {
      step({ id: "check", label: checkLabel, status: "warn", detail: `Offline (${message}) — using installed runtime` });
      return ready(manifest?.version ?? null, false);
    }
    return fail("check", checkLabel, `Runtime not installed and update check failed: ${message}`);
  }
  if (!release) {
    if (toolsReady) {
      step({ id: "check", label: checkLabel, status: "done", detail: `Runtime v${manifest?.version ?? "bundled"} — no releases published yet` });
      if (!manifest) {
        writeManifest(target, { version: "bundled", installedAt: Date.now(), source: `github:${runtimeRepo()}` });
      }
      return ready(manifest?.version ?? "bundled", false);
    }
    return fail("check", checkLabel, "Runtime not installed and no release has been published yet.");
  }
  if (toolsReady && manifest?.version === release.version) {
    step({ id: "check", label: checkLabel, status: "done", detail: `Runtime v${release.version} is up to date` });
    return ready(release.version, false);
  }
  step({
    id: "check",
    label: checkLabel,
    status: "done",
    detail: !toolsReady ? `Runtime ${release.version} will be installed` : `Update available: ${manifest?.version ?? "unknown"} → ${release.version}`
  });
  const stamp = Date.now();
  const tempDir = electron.app.getPath("temp");
  const downloadLabel = `Downloading runtime v${release.version}`;
  const planned = [];
  if (release.bundle) {
    planned.push({ kind: "bundle", asset: release.bundle, dest: path.join(tempDir, `nova-runtime-${stamp}.zip`) });
  } else {
    if (release.prx) planned.push({ kind: "prx", asset: release.prx, dest: path.join(tempDir, `nova-prx-${stamp}.zip`) });
    if (release.relinker) {
      planned.push({ kind: "relinker", asset: release.relinker, dest: path.join(tempDir, `nova-relinker-${stamp}.exe`) });
    }
  }
  if (planned.length === 0) {
    return fail("download", downloadLabel, `release ${release.tag} has no Windows runtime assets`);
  }
  try {
    step({ id: "download", label: downloadLabel, status: "active", percent: 0 });
    let totalBytes = 0;
    for (let i = 0; i < planned.length; i++) {
      const file = planned[i];
      const detail = planned.length > 1 ? `${i + 1}/${planned.length} ${file.asset.name}` : file.asset.name;
      await downloadAsset(file.asset, file.dest, downloadLabel, emit, detail);
      totalBytes += fs.statSync(file.dest).size;
    }
    step({ id: "download", label: downloadLabel, status: "done", detail: `${mb(totalBytes)} — ${planned.length} file${planned.length === 1 ? "" : "s"}` });
  } catch (error) {
    for (const file of planned) fs.rmSync(file.dest, { force: true });
    return fail("download", downloadLabel, error);
  }
  const staging = path.join(path.dirname(target), `.runtime-staging-${stamp}`);
  try {
    step({ id: "extract", label: "Extracting files", status: "active" });
    fs.rmSync(staging, { recursive: true, force: true });
    ensureDir(staging);
    const bundle = planned.find((f) => f.kind === "bundle");
    const prx = planned.find((f) => f.kind === "prx");
    const relinker = planned.find((f) => f.kind === "relinker");
    if (bundle) {
      await extractZip(bundle.dest, staging);
    } else {
      if (!prx) throw new Error("release is missing prx-windows-*.zip");
      if (!relinker) throw new Error("release is missing relinker-*.exe");
      await extractZip(prx.dest, staging);
      fs.copyFileSync(relinker.dest, path.join(staging, "relinker.exe"));
    }
    if (!looksLikeRuntime(staging)) {
      throw new Error("extracted files are missing relinker.exe or libs/*.prx");
    }
    step({ id: "extract", label: "Extracting files", status: "done" });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const file of planned) fs.rmSync(file.dest, { force: true });
    return fail("extract", "Extracting files", error);
  }
  try {
    step({ id: "install", label: "Installing runtime", status: "active" });
    swapIn(staging, target);
    ensureUnwrapScript(target);
    writeManifest(target, {
      version: release.version,
      installedAt: Date.now(),
      source: `github:${runtimeRepo()}`
    });
    for (const file of planned) fs.rmSync(file.dest, { force: true });
    step({ id: "install", label: "Installing runtime", status: "done", detail: `v${release.version}` });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const file of planned) fs.rmSync(file.dest, { force: true });
    return fail("install", "Installing runtime", error);
  }
  return ready(release.version, true);
}
function ensureRuntime(emit) {
  if (!running) {
    running = ensureRuntimeOnce(emit).finally(() => {
      running = null;
    });
  }
  return running;
}
const execFileAsync = util.promisify(child_process.execFile);
async function moveDir(src, dst) {
  try {
    await fs.promises.rename(src, dst);
    return;
  } catch {
  }
  try {
    await execFileAsync("xcopy", [src, dst, "/E", "/I", "/H", "/Y", "/Q"], { windowsHide: true });
  } catch (error) {
    const code = error.code;
    if (code !== 1) throw error;
  }
  ensureDir(dst);
  await fs.promises.rm(src, { recursive: true, force: true });
}
async function setGamesDir(dir) {
  const target = path.resolve(dir);
  const current = path.resolve(gamesRoot());
  if (target === current) return { ok: true, moved: 0 };
  try {
    ensureDir(target);
  } catch (error) {
    return { ok: false, moved: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const games = await listGames();
  const moving = games.filter((g) => path.resolve(path.dirname(g.installPath)) === current);
  for (const game of moving) {
    const dest = path.join(target, path.basename(game.installPath));
    if (path.resolve(dest) !== path.resolve(game.installPath) && fs.existsSync(dest)) {
      return {
        ok: false,
        moved: 0,
        error: `A folder named "${path.basename(game.installPath)}" already exists in the chosen directory.`
      };
    }
  }
  let moved = 0;
  try {
    for (const game of moving) {
      const dest = path.join(target, path.basename(game.installPath));
      if (path.resolve(dest) !== path.resolve(game.installPath)) {
        await moveDir(game.installPath, dest);
      }
      const exePath = game.exePath.startsWith(game.installPath) ? dest + game.exePath.slice(game.installPath.length) : path.join(dest, path.basename(game.exePath));
      await relocateGames([{ id: game.id, installPath: dest, exePath }]);
      moved++;
    }
    saveConfig({ ...loadConfig(), gamesDir: target });
    ensureDir(gamesRoot());
    return { ok: true, moved };
  } catch (error) {
    return {
      ok: false,
      moved,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function appInfo() {
  const { relinker, libs } = toolingPresent();
  return {
    toolsDir: toolsDir(),
    relinkerPresent: relinker,
    libsPresent: libs,
    pythonPath: await findPython(),
    libraryRoot: libraryRoot(),
    gamesDir: gamesRoot(),
    runtimeVersion: readRuntimeManifest()?.version ?? null,
    runtimeRepo: runtimeRepo()
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
  electron.ipcMain.handle("bootstrap:run", () => {
    const win = getWindow();
    return ensureRuntime((step) => win?.webContents.send("bootstrap:step", step));
  });
  electron.ipcMain.handle("settings:get", () => ({
    gamesDir: gamesRoot(),
    runtimeRepo: runtimeRepo()
  }));
  electron.ipcMain.handle("settings:setGamesDir", (_e, dir) => setGamesDir(dir));
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
  electron.protocol.handle("media", async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const [id, ...rest] = rel.split("/").filter(Boolean);
      if (!id || rest.length === 0) return new Response("not found", { status: 404 });
      const game = await getGame(id);
      if (!game) return new Response("not found", { status: 404 });
      const root = path.resolve(game.installPath);
      const full = path.resolve(root, rest.join("/"));
      if (full !== root && !full.startsWith(root + path.sep)) return new Response("forbidden", { status: 403 });
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
