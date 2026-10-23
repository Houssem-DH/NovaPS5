"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const child_process = require("child_process");
const util = require("util");
const os = require("os");
const electronUpdater = require("electron-updater");
const fs$1 = require("node:fs");
const path$1 = require("node:path");
const url = require("url");
const DEFAULT_RUNTIME_REPO = "boykopovar/AnyPS5";
const APP_REPO = "Houssem-DH/NovaPS5";
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
function bundledPythonDir() {
  return electron.app.isPackaged ? path.join(process.resourcesPath, "python") : path.join(electron.app.getAppPath(), "resources", "python");
}
function bundledPythonExe() {
  return path.join(bundledPythonDir(), process.platform === "win32" ? "python.exe" : "python3");
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
function downloadsRoot() {
  return path.join(libraryRoot(), "downloads");
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
    const probe2 = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe2, "");
    fs.rmSync(probe2, { force: true });
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
const DEFAULT_GAME_GRAPHICS = {
  presentMode: "fifo",
  overlayPosition: "tl"
};
function normalizeGameGraphics(value) {
  const presentMode = value?.presentMode === "fifo" || value?.presentMode === "fifo_latest_ready" || value?.presentMode === "mailbox" || value?.presentMode === "immediate" ? value.presentMode : DEFAULT_GAME_GRAPHICS.presentMode;
  const overlayPosition = value?.overlayPosition === "tl" || value?.overlayPosition === "tr" || value?.overlayPosition === "bl" || value?.overlayPosition === "br" ? value.overlayPosition : DEFAULT_GAME_GRAPHICS.overlayPosition;
  return {
    presentMode,
    gpu: typeof value?.gpu === "string" && value.gpu.trim() ? value.gpu.trim() : null,
    overlay: value?.overlay === true,
    overlayPosition,
    shaderCache: value?.shaderCache !== false,
    gpuProfile: value?.gpuProfile === true,
    drawProfile: value?.drawProfile === true,
    telemetry: value?.telemetry !== false
  };
}
function normalizeGameCompatibility(value) {
  return {
    trophyData: value?.trophyData === "placeholders" ? "placeholders" : "package"
  };
}
const TROPHY_HIDDEN_SUFFIX = ".disabled";
const PACKAGE_FILE = /^trophy\d{2}\.ucp(\.disabled)?$/i;
const UCP_MAGIC = 2989016586;
const UCP_VERSION = 1;
const UCP_HEADER_SIZE = 64;
const UCP_TOC_HEADER_SIZE = 32;
const UCP_ENTRY_SIZE = 64;
const UCP_NAME_SIZE = 32;
const UCP_MAX_ENTRIES = 4096;
const UCP_MAX_CONF_BYTES = 4 * 1024 * 1024;
function trophyPackageDir(installPath) {
  return path.join(installPath, "app0", "sce_sys", "trophy2");
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function isHidden(file) {
  return file.toLowerCase().endsWith(TROPHY_HIDDEN_SUFFIX);
}
function packageNameOf(file) {
  return isHidden(file) ? file.slice(0, -TROPHY_HIDDEN_SUFFIX.length) : file;
}
function bigEndian(buffer, offset, size) {
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + buffer[offset + index];
  }
  return value;
}
async function readTrophyCount(file) {
  let handle = null;
  try {
    handle = await fs.promises.open(file, "r");
    const header = Buffer.alloc(UCP_HEADER_SIZE);
    const headerRead = await handle.read(header, 0, UCP_HEADER_SIZE, 0);
    if (headerRead.bytesRead < UCP_HEADER_SIZE) return { trophyCount: null, idRange: null };
    if (bigEndian(header, 0, 4) !== UCP_MAGIC || bigEndian(header, 4, 4) !== UCP_VERSION) {
      return { trophyCount: null, idRange: null };
    }
    const totalSize = bigEndian(header, 8, 8);
    const count = bigEndian(header, 16, 4);
    const toc = bigEndian(header, 20, 4);
    if (count <= 0 || count > UCP_MAX_ENTRIES || toc < UCP_HEADER_SIZE || UCP_TOC_HEADER_SIZE + count * UCP_ENTRY_SIZE > totalSize) {
      return { trophyCount: null, idRange: null };
    }
    const tocBytes = Buffer.alloc(UCP_TOC_HEADER_SIZE + count * UCP_ENTRY_SIZE);
    const tocRead = await handle.read(tocBytes, 0, tocBytes.length, toc);
    if (tocRead.bytesRead < tocBytes.length) return { trophyCount: null, idRange: null };
    let entryOffset = null;
    let entrySize = 0;
    for (let index = 0; index < count; index += 1) {
      const entry = UCP_TOC_HEADER_SIZE + index * UCP_ENTRY_SIZE;
      const name = tocBytes.subarray(entry, entry + UCP_NAME_SIZE).toString("utf8").replace(/\0.*$/s, "");
      if (name !== "tropconf.json") continue;
      entryOffset = bigEndian(tocBytes, entry + UCP_NAME_SIZE, 8);
      entrySize = bigEndian(tocBytes, entry + UCP_NAME_SIZE + 8, 8);
      break;
    }
    if (entryOffset === null || entrySize === 0 || entrySize > UCP_MAX_CONF_BYTES) {
      return { trophyCount: null, idRange: null };
    }
    const conf = Buffer.alloc(entrySize);
    const confRead = await handle.read(conf, 0, entrySize, entryOffset);
    if (confRead.bytesRead < entrySize) return { trophyCount: null, idRange: null };
    const parsed = JSON.parse(conf.toString("utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed.trophies)) return { trophyCount: null, idRange: null };
    const ids = parsed.trophies.map((trophy) => trophy.id).filter((id) => typeof id === "string" || typeof id === "number").map((id) => String(id)).sort();
    return {
      trophyCount: parsed.trophies.length,
      idRange: ids.length > 0 ? [ids[0], ids[ids.length - 1]] : null
    };
  } catch {
    return { trophyCount: null, idRange: null };
  } finally {
    if (handle) await handle.close().catch(() => {
    });
  }
}
async function readTrophyPackages(installPath) {
  const dir = trophyPackageDir(installPath);
  let names;
  try {
    names = (await fs.promises.readdir(dir)).filter((name) => PACKAGE_FILE.test(name));
  } catch (error) {
    if (error.code === "ENOENT") return { dir, files: [] };
    return { dir, files: [], error: messageOf(error) };
  }
  const files = [];
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    let sizeBytes = 0;
    try {
      sizeBytes = (await fs.promises.stat(full)).size;
    } catch {
    }
    const hidden = isHidden(name);
    const details = await readTrophyCount(full);
    files.push({
      file: name,
      packageName: packageNameOf(name),
      disabled: hidden,
      sizeBytes,
      ...details
    });
  }
  files.sort(
    (a, b) => a.packageName === b.packageName ? Number(a.disabled) - Number(b.disabled) : a.packageName.localeCompare(b.packageName)
  );
  return { dir, files };
}
async function setTrophyDataMode(installPath, mode) {
  const dir = trophyPackageDir(installPath);
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return { changed: [] };
    return { changed: [], error: `Could not read ${dir}: ${messageOf(error)}` };
  }
  const changed = [];
  const errors = [];
  const present = new Set(names.map((name) => name.toLowerCase()));
  const rename = async (from, to) => {
    try {
      await fs.promises.rename(path.join(dir, from), path.join(dir, to));
      changed.push(from);
    } catch (error) {
      errors.push(`${from}: ${messageOf(error)}`);
    }
  };
  if (mode === "placeholders") {
    for (const name of names) {
      if (isHidden(name) || !PACKAGE_FILE.test(name)) continue;
      if (present.has(`${name}${TROPHY_HIDDEN_SUFFIX}`.toLowerCase())) continue;
      await rename(name, `${name}${TROPHY_HIDDEN_SUFFIX}`);
    }
  } else {
    for (const name of names) {
      if (!isHidden(name)) continue;
      const restored = packageNameOf(name);
      if (present.has(restored.toLowerCase())) continue;
      await rename(name, restored);
    }
  }
  return errors.length > 0 ? { changed, error: `Could not update the trophy package: ${errors.join("; ")}` } : { changed };
}
let cache$3 = null;
async function load$1() {
  if (cache$3) return cache$3;
  cache$3 = { games: [] };
  try {
    const raw = await fs.promises.readFile(libraryFile(), "utf8");
    const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
    const parsed = JSON.parse(text);
    cache$3 = { games: Array.isArray(parsed.games) ? parsed.games : [] };
  } catch {
    try {
      const backup = await fs.promises.readFile(`${libraryFile()}.bak`, "utf8");
      const text = backup.charCodeAt(0) === 65279 ? backup.slice(1) : backup;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.games)) cache$3 = { games: parsed.games };
    } catch {
    }
  }
  return cache$3;
}
async function persist$1() {
  if (!cache$3) return;
  ensureDir(path.dirname(libraryFile()));
  const file = libraryFile();
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(cache$3, null, 2), "utf8");
  await fs.promises.copyFile(file, `${file}.bak`).catch(() => {
  });
  await fs.promises.rename(tmp, file);
}
function slugify(name) {
  const slug2 = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug2 || "game";
}
async function listGames() {
  const data = await load$1();
  return [...data.games].sort((a, b) => b.installedAt - a.installedAt);
}
async function getGame(id) {
  const data = await load$1();
  return data.games.find((game) => game.id === id);
}
async function addGame(game) {
  const data = await load$1();
  const index = data.games.findIndex((g) => g.id === game.id);
  if (index >= 0) {
    const previous = data.games[index];
    game.graphics ??= previous.graphics;
    game.compatibility ??= previous.compatibility;
    game.lastPlayedAt ??= previous.lastPlayedAt;
    data.games[index] = game;
  } else {
    data.games.push(game);
  }
  await persist$1();
}
async function removeGame(id) {
  const data = await load$1();
  const game = data.games.find((g) => g.id === id);
  data.games = data.games.filter((g) => g.id !== id);
  await persist$1();
  if (game) {
    await fs.promises.rm(game.installPath, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function touchPlay(id) {
  const data = await load$1();
  const game = data.games.find((g) => g.id === id);
  if (game) {
    game.lastPlayedAt = Date.now();
    await persist$1();
  }
}
async function setGameGraphics(id, patch) {
  const data = await load$1();
  const game = data.games.find((g) => g.id === id);
  if (!game) throw new Error("Game not found in library.");
  game.graphics = normalizeGameGraphics({ ...game.graphics ?? {}, ...patch });
  await persist$1();
  return game;
}
async function setGameCompatibility(id, patch) {
  const data = await load$1();
  const game = data.games.find((g) => g.id === id);
  if (!game) throw new Error("Game not found in library.");
  const compatibility = normalizeGameCompatibility({
    ...game.compatibility ?? {},
    ...patch
  });
  const applied = await setTrophyDataMode(game.installPath, compatibility.trophyData);
  if (applied.error) throw new Error(applied.error);
  game.compatibility = compatibility;
  await persist$1();
  return game;
}
async function clearShaderCache(id) {
  const game = await getGame(id);
  if (!game) return { ok: false, error: "Game not found in library." };
  const dir = path.join(game.installPath, "shader_cache");
  try {
    const freedBytes = await dirSize$1(dir);
    await fs.promises.rm(dir, { recursive: true, force: true });
    return { ok: true, freedBytes };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function relocateGames(updates) {
  const data = await load$1();
  for (const update of updates) {
    const game = data.games.find((g) => g.id === update.id);
    if (game) {
      game.installPath = update.installPath;
      game.exePath = update.exePath;
    }
  }
  await persist$1();
}
async function exists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}
async function dirSize$1(dir) {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize$1(full);
      } else {
        try {
          total += (await fs.promises.stat(full)).size;
        } catch {
        }
      }
    }
  } catch {
  }
  return total;
}
async function readTitleId(dir) {
  try {
    const raw = await fs.promises.readFile(path.join(dir, "app0", "sce_sys", "param.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.titleId === "string" ? parsed.titleId : null;
  } catch {
    return null;
  }
}
async function looksInstalled(dir) {
  try {
    if (!await exists(path.join(dir, "app0"))) return null;
    const files = await fs.promises.readdir(dir);
    const exe = files.find((f) => f.toLowerCase().endsWith(".exe"));
    return exe ?? null;
  } catch {
    return null;
  }
}
async function scanLibrary() {
  cache$3 = null;
  const data = await load$1();
  const summary = { added: 0, missing: 0, repaired: 0 };
  for (const game of data.games) {
    const exeOk = await exists(game.exePath);
    const dirOk = await exists(game.installPath);
    const conversionFailure = game.status === "error" && !!game.error?.startsWith("Conversion failed");
    if (exeOk && !conversionFailure) {
      if (game.status !== "ready" || game.error) {
        game.status = "ready";
        delete game.error;
        summary.repaired++;
      }
    } else {
      const detail = conversionFailure && dirOk ? game.error : dirOk ? "The game executable is missing — reinstall the game." : "The install folder is gone.";
      if (game.status !== "error" || game.error !== detail) {
        game.status = "error";
        game.error = detail;
        summary.missing++;
      }
    }
  }
  const root = gamesRoot();
  let dirs = [];
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".old")).map((e) => e.name);
  } catch {
    dirs = [];
  }
  const known = new Set(data.games.map((g) => path.resolve(g.installPath)));
  for (const name of dirs) {
    const dir = path.join(root, name);
    if (known.has(path.resolve(dir))) continue;
    const exe = await looksInstalled(dir);
    if (!exe) continue;
    let installedAt = Date.now();
    try {
      installedAt = (await fs.promises.stat(dir)).birthtimeMs || installedAt;
    } catch {
    }
    const game = {
      id: name,
      name: path.basename(exe, path.extname(exe)),
      titleId: await readTitleId(dir),
      sourcePath: "",
      installPath: dir,
      exePath: path.join(dir, exe),
      sizeBytes: await dirSize$1(dir),
      cover: await exists(path.join(dir, "cover.png")) ? "cover.png" : null,
      status: "ready",
      installedAt
    };
    data.games.push(game);
    summary.added++;
  }
  if (summary.added > 0 || summary.missing > 0 || summary.repaired > 0) await persist$1();
  const games = [...data.games].sort((a, b) => b.installedAt - a.installedAt);
  return { games, summary };
}
const MAX_SAMPLES = 240;
const TAIL_BYTES = 512 * 1024;
const KEEP_TELEMETRY_SESSIONS = 20;
const sessions = /* @__PURE__ */ new Map();
function telemetryRoot() {
  return path.join(electron.app.getPath("userData"), "telemetry");
}
async function createTelemetryDir(gameId) {
  const safeId = gameId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "game";
  const parent = path.join(telemetryRoot(), safeId);
  const dir = path.join(parent, String(Date.now()));
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    const entries = await fs.promises.readdir(parent, { withFileTypes: true });
    const previous = entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => entry.name).sort();
    for (const stale of previous.slice(0, Math.max(0, previous.length - KEEP_TELEMETRY_SESSIONS))) {
      await fs.promises.rm(path.join(parent, stale), { recursive: true, force: true });
    }
  } catch {
  }
  return dir;
}
function beginSession(gameId, pid, telemetryDir) {
  sessions.set(gameId, {
    gameId,
    pid,
    startedAt: Date.now(),
    telemetryPath: telemetryDir ? path.join(telemetryDir, "videoout.jsonl") : null,
    samples: [],
    dropped: 0,
    lastSampleAt: void 0,
    telemetrySize: void 0,
    telemetryMtimeMs: void 0
  });
}
function finishSession(gameId, pid) {
  const session = sessions.get(gameId);
  if (!session) return;
  if (pid !== void 0 && session.pid !== void 0 && session.pid !== pid) return;
  session.endedAt = Date.now();
}
function parseTelemetry(text, fromStart) {
  const lines = text.split("\n");
  if (!fromStart && lines.length > 0) lines.shift();
  const samples = [];
  let dropped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.ev === "present" && typeof entry.fps === "number" && Number.isFinite(entry.fps) && typeof entry.t_ns === "number") {
        samples.push({ t: Math.round(entry.t_ns / 1e6), fps: Math.max(0, entry.fps) });
      } else if (entry.ev === "drops" && typeof entry.dropped === "number") {
        dropped = Math.max(dropped, entry.dropped);
      }
    } catch {
    }
  }
  return { samples, dropped };
}
async function readTelemetryFile(file) {
  let handle = null;
  try {
    handle = await fs.promises.open(file, "r");
    const stat = await handle.stat();
    const fromStart = stat.size <= TAIL_BYTES;
    const start = fromStart ? 0 : Math.max(0, stat.size - TAIL_BYTES - 1);
    const length = stat.size - start;
    if (length <= 0) return { samples: [], dropped: 0 };
    const buffer = Buffer.alloc(Number(length));
    await handle.read(buffer, 0, buffer.length, start);
    return parseTelemetry(buffer.toString("utf8"), fromStart);
  } catch {
    return { samples: [], dropped: 0 };
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
async function readSession(gameId) {
  const session = sessions.get(gameId);
  if (!session) {
    return { active: false, telemetry: false, samples: [], dropped: 0 };
  }
  if (session.telemetryPath) {
    try {
      const stat = await fs.promises.stat(session.telemetryPath);
      const changed = stat.size !== session.telemetrySize || stat.mtimeMs !== session.telemetryMtimeMs;
      if (changed) {
        session.telemetrySize = stat.size;
        session.telemetryMtimeMs = stat.mtimeMs;
        const { samples, dropped } = await readTelemetryFile(session.telemetryPath);
        if (samples.length > 0) {
          const previousLast = session.samples[session.samples.length - 1]?.t;
          const nextLast = samples[samples.length - 1]?.t;
          if (previousLast === void 0 || nextLast !== void 0 && nextLast > previousLast) {
            session.lastSampleAt = Date.now();
          }
          session.samples = samples.slice(-MAX_SAMPLES);
        }
        if (dropped > session.dropped) session.dropped = dropped;
      }
    } catch {
    }
  }
  const active2 = session.endedAt === void 0;
  return {
    active: active2,
    pid: session.pid,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    telemetry: session.telemetryPath !== null,
    samples: session.samples,
    dropped: session.dropped,
    lastSampleAt: session.lastSampleAt
  };
}
function graphicsEnvironment(graphics) {
  const settings = normalizeGameGraphics(graphics);
  const env = { ...process.env };
  env.ANYPS5_PRESENT_MODE = settings.presentMode;
  const gpu = settings.gpu?.trim();
  if (gpu) env.ANYPS5_GPU = gpu;
  else delete env.ANYPS5_GPU;
  if (settings.overlay) {
    env.ANYPS5_OVERLAY = "1";
    env.ANYPS5_OVERLAY_POS = settings.overlayPosition;
  } else {
    delete env.ANYPS5_OVERLAY;
    delete env.ANYPS5_OVERLAY_POS;
  }
  if (settings.shaderCache) delete env.ANYPS5_NO_SHADER_CACHE;
  else env.ANYPS5_NO_SHADER_CACHE = "1";
  if (settings.gpuProfile) env.APS5_PROFILE_GPU = "1";
  else delete env.APS5_PROFILE_GPU;
  if (settings.drawProfile) env.APS5_PROFILE_DRAW = "1";
  else delete env.APS5_PROFILE_DRAW;
  return env;
}
async function launchGame(id) {
  const game = await getGame(id);
  if (!game) return { ok: false, error: "Game not found in library." };
  if (game.status === "error") {
    return { ok: false, error: game.error ?? "This game is not working and cannot be launched." };
  }
  const graphics = normalizeGameGraphics(game.graphics);
  const env = graphicsEnvironment(graphics);
  const compatibility = normalizeGameCompatibility(game.compatibility);
  const trophies = await setTrophyDataMode(game.installPath, compatibility.trophyData);
  if (trophies.error) return { ok: false, error: trophies.error };
  let telemetryDir = null;
  if (graphics.telemetry) {
    try {
      telemetryDir = await createTelemetryDir(game.id);
      env.APS5_VIDEOOUT_TELEMETRY_DIR = telemetryDir;
    } catch {
      delete env.APS5_VIDEOOUT_TELEMETRY_DIR;
    }
  } else {
    delete env.APS5_VIDEOOUT_TELEMETRY_DIR;
  }
  try {
    const child = child_process.spawn(game.exePath, [], {
      cwd: game.installPath,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env
    });
    child.on("error", () => {
      if (child.pid !== void 0) finishSession(id, child.pid);
    });
    if (child.pid !== void 0) {
      beginSession(id, child.pid, telemetryDir);
      child.on("exit", () => finishSession(id, child.pid));
    }
    child.unref();
    await touchPlay(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
const ATTRIBUTE3_HIGH_FRAME_RATE = 64;
function attribute3Of(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: null, detail: "The game’s param.json is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object") {
    return { value: null, detail: "The game’s param.json is not a JSON object." };
  }
  const value = parsed.attribute3;
  if (value === void 0) {
    return {
      value: 0,
      detail: "The game’s param.json has no attribute3 field, so the runtime treats it as 0."
    };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4294967295) {
    return {
      value: null,
      detail: "The game’s param.json has an attribute3 value the runtime does not accept."
    };
  }
  return { value: value >>> 0 };
}
async function readPerformanceProfile(game) {
  const paramJson = path.join(game.installPath, "app0", "sce_sys", "param.json");
  let raw;
  try {
    raw = await fs.promises.readFile(paramJson, "utf8");
  } catch {
    return {
      attribute3: null,
      highFrameRate: null,
      source: "none",
      detail: "NovaPS5 could not read this game’s app0/sce_sys/param.json, so its 120 Hz output flag is unknown."
    };
  }
  const { value, detail } = attribute3Of(raw);
  return {
    attribute3: value,
    highFrameRate: value === null ? null : (value & ATTRIBUTE3_HIGH_FRAME_RATE) !== 0,
    source: "param.json",
    detail
  };
}
const SELF_MAGIC = Buffer.from([79, 21, 61, 29]);
const SELF_KERNEL_MAGIC = Buffer.from([84, 20, 245, 238]);
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
    if (buf.subarray(0, 4).equals(SELF_MAGIC) || buf.subarray(0, 4).equals(SELF_KERNEL_MAGIC)) return "self";
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
function readElfDynamicInfo(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, 64, 0) < 52) return null;
    if (!head.subarray(0, 4).equals(ELF_MAGIC)) return null;
    if (head[5] !== 1) return null;
    const is64 = head[4] === 2;
    const phoff = Number(is64 ? head.readBigUInt64LE(32) : head.readUInt32LE(28));
    const phentsize = head.readUInt16LE(is64 ? 54 : 42);
    const phnum = head.readUInt16LE(is64 ? 56 : 44);
    if (phnum === 0 || phnum > 1024 || phentsize < (is64 ? 56 : 32)) return null;
    const loads = [];
    let dynOff = -1;
    let dynSize = 0;
    const phdr = Buffer.alloc(phentsize);
    for (let i = 0; i < phnum; i++) {
      if (fs.readSync(fd, phdr, 0, phentsize, phoff + i * phentsize) < phentsize) return null;
      const type = phdr.readUInt32LE(0);
      if (is64) {
        const off = Number(phdr.readBigUInt64LE(8));
        const vaddr = Number(phdr.readBigUInt64LE(16));
        const filesz = Number(phdr.readBigUInt64LE(32));
        if (type === 1) loads.push({ vaddr, off, filesz });
        else if (type === 2) {
          dynOff = off;
          dynSize = filesz;
        }
      } else {
        const off = phdr.readUInt32LE(4);
        const vaddr = phdr.readUInt32LE(8);
        const filesz = phdr.readUInt32LE(16);
        if (type === 1) loads.push({ vaddr, off, filesz });
        else if (type === 2) {
          dynOff = off;
          dynSize = filesz;
        }
      }
    }
    if (dynOff < 0 || dynSize <= 0) return { needed: [], soname: null };
    const vaddrToOff = (vaddr) => {
      for (const load2 of loads) {
        if (vaddr >= load2.vaddr && vaddr < load2.vaddr + load2.filesz) {
          return load2.off + (vaddr - load2.vaddr);
        }
      }
      return -1;
    };
    const entrySize = is64 ? 16 : 8;
    const dyn = Buffer.alloc(Math.min(dynSize, entrySize * 4096));
    const dynRead = fs.readSync(fd, dyn, 0, dyn.length, dynOff);
    if (dynRead < entrySize) return { needed: [], soname: null };
    const tags = [];
    for (let o = 0; o + entrySize <= dynRead; o += entrySize) {
      const tag = is64 ? Number(dyn.readBigInt64LE(o)) : dyn.readInt32LE(o);
      if (tag === 0) break;
      const val = is64 ? Number(dyn.readBigUInt64LE(o + 8)) : dyn.readUInt32LE(o + 4);
      tags.push({ tag, val });
    }
    const strtabVal = tags.find((t) => t.tag === 5)?.val;
    if (strtabVal === void 0) return { needed: [], soname: null };
    const strOff = vaddrToOff(strtabVal);
    if (strOff < 0) return null;
    const strsz = tags.find((t) => t.tag === 10)?.val ?? 65536;
    const strtab = Buffer.alloc(Math.min(strsz, 4 << 20));
    const strRead = fs.readSync(fd, strtab, 0, strtab.length, strOff);
    if (strRead <= 0) return null;
    const stringAt = (offset) => {
      if (offset < 0 || offset >= strRead) return null;
      const end = strtab.indexOf(0, offset);
      const name = strtab.subarray(offset, end === -1 ? strRead : end).toString("latin1");
      return name || null;
    };
    const needed = [];
    for (const { tag, val } of tags) {
      if (tag !== 1) continue;
      const name = stringAt(val);
      if (name) needed.push(name);
    }
    const sonameTag = tags.find((t) => t.tag === 14);
    const soname = sonameTag ? stringAt(sonameTag.val) : null;
    return { needed, soname };
  } catch {
    return null;
  } finally {
    if (fd !== void 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function readMagicHex(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 0);
    if (read <= 0) return "empty";
    return Array.from(buf.subarray(0, read)).map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  } catch {
    return "unreadable";
  } finally {
    if (fd !== void 0) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = child_process.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", () => {
      });
      killer.unref();
    } catch {
    }
  }
  try {
    child.kill();
  } catch {
  }
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
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
        timedOut = true;
        killTree(child);
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
      fail(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr, timedOut });
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
async function probe(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync$2(cmd, [...args, "--version"], {
      windowsHide: true,
      timeout: 1e4
    });
    return /Python\s+3\./i.test(`${stdout}${stderr}`);
  } catch {
    return false;
  }
}
async function pythonInvocation() {
  if (cached !== void 0) return cached;
  const bundled = bundledPythonExe();
  if (fs.existsSync(bundled) && await probe(bundled, [])) {
    cached = { cmd: bundled, args: [], bundled: true };
    return cached;
  }
  const candidates = [
    { cmd: "py", args: ["-3"], bundled: false },
    { cmd: "python", args: [], bundled: false },
    { cmd: "python3", args: [], bundled: false }
  ];
  for (const candidate of candidates) {
    if (await probe(candidate.cmd, candidate.args)) {
      cached = candidate;
      return cached;
    }
  }
  cached = null;
  return null;
}
async function findPython() {
  const invocation = await pythonInvocation();
  if (!invocation) return null;
  return invocation.args.length ? `${invocation.cmd} ${invocation.args.join(" ")}` : invocation.cmd;
}
async function unwrapSelf(input, output, verbose = false) {
  const python = await pythonInvocation();
  if (!python) {
    throw new Error(
      "No Python 3 interpreter is available. NovaPS5 bundles one — repair or reinstall the app."
    );
  }
  const inPlace = path.resolve(input) === path.resolve(output);
  const target = inPlace ? path.join(
    path.dirname(output),
    `.${path.basename(output)}.novaps5-unwrap-${process.pid}-${Date.now()}.tmp`
  ) : output;
  try {
    await fs.promises.rm(target, { force: true }).catch(() => {
    });
    const args = [...python.args, unwrapScriptPath(), input, target];
    if (verbose) args.push("--verbose");
    const result = await run(python.cmd, args, { timeoutMs: 10 * 60 * 1e3 });
    if (result.timedOut) {
      throw new Error(`${path.basename(input)} could not be unwrapped — the step timed out.`);
    }
    if (result.code !== 0) {
      const { stderr, stdout } = result;
      const detail = /not a SELF container/i.test(stderr) ? `${path.basename(input)} is not a SELF container.` : /looks encrypted/i.test(stderr) ? `${path.basename(input)} is still encrypted — dump it decrypted before converting.` : stderr.trim() || stdout.trim() || `the unwrapper exited with code ${result.code}`;
      throw new Error(detail);
    }
    const kind = detectContainer(target);
    if (kind !== "elf") {
      throw new Error(
        kind === "unknown" ? `${path.basename(input)} did not produce a usable ELF — the file is truncated or uses an unsupported container.` : `${path.basename(input)} unwrapped to a ${kind.toUpperCase()} file instead of an ELF — the container is malformed.`
      );
    }
    if (inPlace) await fs.promises.rename(target, output);
  } catch (error) {
    await fs.promises.rm(target, { force: true }).catch(() => {
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/^Unwrap failed\b/.test(message) ? message : `Unwrap failed — ${message}`);
  }
}
class RelinkError extends Error {
  detail;
  output;
  constructor(detail, output) {
    super(`Conversion failed — ${explainRelinkFailure(detail)}`);
    this.name = "RelinkError";
    this.detail = detail;
    this.output = output;
  }
}
function explainRelinkFailure(detail) {
  const rules = [
    [
      /^Ambiguous guest dependency name: (.+)$/i,
      (m) => `Two module files claim the name "${m[1]}" — usually a leftover backup copy (like *.bak) inside a module folder. Remove the duplicate file from the dump and retry.`
    ],
    [
      /^Conflicting guest output filename: (.+)$/i,
      (m) => `Two modules would be written out as "${m[1]}" — remove one of the duplicate module files from the dump.`
    ],
    [
      /^Ambiguous guest module identity: (.+)$/i,
      (m) => `Several modules identify as "${m[1]}" (same SONAME in different folders) — remove the duplicate copies from the dump.`
    ],
    [
      /^Unsupported (?:Windows )?guest filename: (.+)$/i,
      (m) => `The module filename "${m[1]}" contains characters Windows cannot use — rename that module inside the dump and retry.`
    ],
    [
      /^Neither DT_OS_ nor DT_ variant present for DT_SYMTAB/i,
      () => "The executable has no usable dynamic symbol table — it is not a standard PS5 ELF. Re-extract the dump; if it still fails, the eboot is unsupported."
    ],
    [
      /^Both sce_module and sce_modules exist/i,
      () => "The dump has both sce_module/ and sce_modules/ — keep only one of them."
    ],
    [
      /^Guest module parent directory does not exist/i,
      () => "The dump has no module folder and the converter could not create one — check that the games folder is writable and retry."
    ],
    [
      /^Guest module path is not a directory: (.+)$/i,
      (m) => `The module folder "${m[1]}" is missing or is not a folder — retry the installation.`
    ],
    [
      /^Duplicate guest module directory: (.+)$/i,
      (m) => `The module folder "${m[1]}" was passed more than once — retry the installation; the duplicate scan is automatic.`
    ],
    [
      /^Excluded guest module file not found/i,
      () => "The dump layout changed mid-conversion — retry the installation."
    ],
    [
      /cannot (?:read|open) (?:the )?(?:input|executable)/i,
      () => "The unwrapped eboot could not be read — re-import the dump."
    ]
  ];
  for (const [pattern, describe] of rules) {
    const match = detail.match(pattern);
    if (match) return describe(match);
  }
  return detail;
}
function findSkippedSelf(stdout) {
  const skipped = [];
  const pattern = /Skipping SELF container:\s*([^\r\n]+)/gi;
  for (let match = pattern.exec(stdout); match; match = pattern.exec(stdout)) {
    const name = match[1].replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (name) skipped.push(name);
  }
  return skipped;
}
async function relink(inputElf, outputExe, options = {}) {
  const args = ["--windows"];
  if (options.windowsDiagnostics !== false) args.push("--windows-diagnostics");
  for (const dir of options.moduleDirs ?? []) args.push("--module-dir", dir);
  for (const name of options.excludeModules ?? []) args.push("--exclude-sce-module", name);
  args.push(inputElf, outputExe);
  const result = await run(relinkerPath(), args, {
    onOutput: options.onOutput,
    cwd: options.cwd,
    timeoutMs: 30 * 60 * 1e3
  });
  if (result.timedOut) {
    throw new Error(
      `Conversion failed — the converter ran for over 30 minutes on ${path.basename(inputElf)} and was stopped. The dump may contain an unusually large executable.`
    );
  }
  if (result.code !== 0) {
    const output = `${result.stderr}
${result.stdout}`;
    const detail = extractFailure(output) ?? `relinker exited with code ${result.code}`;
    throw new RelinkError(detail, output);
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    skippedSelf: findSkippedSelf(result.stdout)
  };
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
async function copyDir(src, dest, onBytes, depth = 0) {
  if (depth > 32) return;
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, onBytes, depth + 1);
      continue;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const followed = await fs.promises.stat(from);
        if (followed.isDirectory()) {
          await copyDir(from, to, onBytes, depth + 1);
        } else {
          await fs.promises.copyFile(from, to);
          onBytes(followed.size);
        }
        break;
      } catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") break;
        if (attempt < 2 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
          continue;
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not copy "${from}" — ${detail}`);
      }
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
  const libsSource = runtimeLibsDir();
  try {
    if (!(await fs.promises.stat(libsSource)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(
      "The shared runtime libraries are missing — repair or reinstall the conversion runtime, then retry."
    );
  }
  const libsLink = path.join(installDir, "libs");
  try {
    await fs.promises.rm(libsLink, { recursive: true, force: true });
  } catch {
  }
  try {
    await fs.promises.symlink(libsSource, libsLink, "junction");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not link the runtime libraries into the install — ${detail}. Make sure the games folder is on a local, writable drive and retry.`
    );
  }
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
function isBackupName(name) {
  return /\.(bak|backup|old|orig)([._-].*)?$/i.test(name) || name.endsWith("~");
}
function moduleDirRank(rel) {
  const key = rel.replace(/\\/g, "/").toLowerCase();
  if (key === "sce_module") return 0;
  if (key === "sce_modules") return 1;
  if (key === "prx") return 2;
  return 3;
}
function normalizeLibName(name) {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.toLowerCase().replace(/\.(prx|sprx|so|elf)$/, "");
}
const MODULE_EXTENSIONS = /\.(prx|sprx|so|elf)$/i;
const MODULE_DIR_NAMES = /^(sce_modules?|prx|modules?|plugins?)$/i;
const MAX_SCAN_DEPTH = 6;
function isShimModuleDir(rel) {
  return rel.split(/[\\/]+/).some((part) => /^fake[-_ ]?libs?$/i.test(part));
}
function sortCandidates(items) {
  return items.sort(
    (a, b) => moduleDirRank(a.rel) - moduleDirRank(b.rel) || a.rel.localeCompare(b.rel) || a.name.localeCompare(b.name)
  );
}
async function discoverModuleFiles(root) {
  const dirs = /* @__PURE__ */ new Set();
  const files = [];
  const shims = [];
  const backups = [];
  const leftovers = [];
  const visit = async (full, rel, depth) => {
    if (depth > MAX_SCAN_DEPTH) return;
    const shimDir = rel !== "" && isShimModuleDir(rel);
    let entries;
    try {
      entries = await fs.promises.readdir(full, { withFileTypes: true });
    } catch {
      return;
    }
    const suspiciousDir = rel !== "" && MODULE_DIR_NAMES.test(path.basename(full));
    const dirFiles = [];
    const dirBackups = [];
    const possibleBackups = [];
    const otherFiles = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "sce_sys" || entry.name === "__MACOSX" || entry.name === "app0") continue;
        await visit(path.join(full, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = entry.name;
      const filePath = path.join(full, name);
      const lowerName = name.toLowerCase();
      if (lowerName.endsWith(".guest.prx") || /\.novaps5-unwrap-.*\.tmp$/i.test(name)) {
        leftovers.push(rel ? `${rel}/${name}` : name);
        continue;
      }
      if (lowerName.endsWith(".esbak")) {
        leftovers.push(rel ? `${rel}/${name}` : name);
        possibleBackups.push({ name, path: filePath });
        continue;
      }
      if (shimDir) {
        if (!isBackupName(name)) shims.push({ rel, name });
        continue;
      }
      if (isBackupName(name)) {
        possibleBackups.push({ name, path: filePath });
        continue;
      }
      if (!rel) continue;
      if (!suspiciousDir && !MODULE_EXTENSIONS.test(name)) {
        otherFiles.push({ name, path: filePath });
        continue;
      }
      const kind = detectContainer(filePath);
      if (kind === "elf" || kind === "self") {
        dirFiles.push({ rel, name, path: filePath, magic: kind });
      }
    }
    if (dirFiles.length > 0 && !suspiciousDir) {
      for (const file of otherFiles) {
        const kind = detectContainer(file.path);
        if (kind === "elf" || kind === "self") {
          dirFiles.push({ rel, name: file.name, path: file.path, magic: kind });
        }
      }
    }
    if (dirFiles.length > 0 || suspiciousDir) {
      for (const backup of possibleBackups) {
        const kind = detectContainer(backup.path);
        if (kind === "elf" || kind === "self") {
          dirBackups.push(rel ? `${rel}/${backup.name}` : backup.name);
          leftovers.push(rel ? `${rel}/${backup.name}` : backup.name);
        }
      }
    }
    if (dirFiles.length > 0) {
      if (rel) dirs.add(rel);
      files.push(...dirFiles);
      backups.push(...dirBackups);
    } else if (suspiciousDir && dirBackups.length > 0) {
      backups.push(...dirBackups);
    }
  };
  await visit(root, "", 0);
  return {
    dirs: [...dirs].sort((a, b) => moduleDirRank(a) - moduleDirRank(b) || a.localeCompare(b)),
    files: sortCandidates(files),
    shims: shims.sort((a, b) => a.rel.localeCompare(b.rel) || a.name.localeCompare(b.name)),
    backups,
    leftovers: [...new Set(leftovers)]
  };
}
function errorDetail(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Unwrap failed — /, "");
}
async function checkCompatibility(root) {
  const checks = [];
  const eboot = path.join(root, "eboot.bin");
  const kind = fs.existsSync(eboot) ? detectContainer(eboot) : "missing";
  if (kind === "elf") {
    checks.push({
      id: "eboot",
      label: "Executable",
      status: "pass",
      detail: "eboot.bin is a plain ELF — no unwrap needed."
    });
  } else if (kind === "self") {
    checks.push({
      id: "eboot",
      label: "Executable",
      status: "pass",
      detail: "eboot.bin is a PS5 SELF container — unwraps automatically."
    });
  } else if (kind === "missing") {
    checks.push({
      id: "eboot",
      label: "Executable",
      status: "fail",
      detail: "eboot.bin not found — this folder is not a complete dump."
    });
  } else if (kind === "pe") {
    checks.push({
      id: "eboot",
      label: "Executable",
      status: "fail",
      detail: "eboot.bin is a Windows executable, not a PS5 dump — this folder looks already converted. Import the original dump folder instead."
    });
  } else {
    const bytes = readMagicHex(eboot);
    if (bytes === "empty" || bytes === "unreadable") {
      checks.push({
        id: "eboot",
        label: "Executable",
        status: "fail",
        detail: `eboot.bin is ${bytes} — the dump is incomplete; re-copy or re-extract it.`
      });
    } else {
      checks.push({
        id: "eboot",
        label: "Executable",
        status: "warn",
        detail: `eboot.bin is not a recognized ELF or SELF file (first bytes: ${bytes}) — it cannot be converted. Installation will complete with the game marked Not working.`
      });
    }
  }
  const discovery = kind === "missing" ? { dirs: [], files: [], shims: [], backups: [], leftovers: [] } : await discoverModuleFiles(root);
  const moduleNotes = [];
  const moduleFileNames = /* @__PURE__ */ new Set();
  for (const file of discovery.files) moduleFileNames.add(file.name.toLowerCase());
  const hasSingular = fs.existsSync(path.join(root, "sce_module"));
  const hasPlural = fs.existsSync(path.join(root, "sce_modules"));
  const hasPrxDir = fs.existsSync(path.join(root, "prx"));
  const hasRootModuleDir = hasSingular || hasPlural || hasPrxDir;
  if (hasSingular && hasPlural) {
    moduleNotes.push({
      id: "modules-both",
      label: "Modules",
      status: "warn",
      detail: "Both sce_module/ and sce_modules/ exist — sce_modules/ will be merged into sce_module/ automatically."
    });
  }
  if (!hasRootModuleDir && discovery.dirs.length === 0 && discovery.backups.length === 0) {
    moduleNotes.push({
      id: "modules-none",
      label: "Modules",
      status: "warn",
      detail: "No module folder found — conversion will continue without bundled modules. Games that need their own libraries may fail to launch."
    });
  } else if (discovery.files.length === 0) {
    moduleNotes.push({
      id: "modules-empty",
      label: "Modules",
      status: "warn",
      detail: "Module folders contain no loadable modules — conversion will continue without them. Some games may fail to launch."
    });
  }
  if (discovery.shims.length > 0) {
    const folders = [...new Set(discovery.shims.map((file) => file.rel))].join(", ");
    moduleNotes.push({
      id: "modules-shims",
      label: "Modules",
      status: "pass",
      detail: `${discovery.shims.length} stand-in system librar${discovery.shims.length === 1 ? "y" : "ies"} in ${folders} will be left alone — the runtime provides its own implementations, and converting these stubs stops the game from starting.`
    });
  }
  const previousOutputs = discovery.leftovers.filter((rel) => /\.guest\.prx$/i.test(rel));
  if (previousOutputs.length > 0) {
    const shown = previousOutputs.slice(0, 3).join(", ");
    const more = previousOutputs.length > 3 ? ` (+${previousOutputs.length - 3} more)` : "";
    moduleNotes.push({
      id: "modules-outputs",
      label: "Modules",
      status: "warn",
      detail: `Previous conversion output${previousOutputs.length === 1 ? "" : "s"} will be removed before converting: ${shown}${more}.`
    });
  }
  const byName = /* @__PURE__ */ new Map();
  for (const file of discovery.files) {
    const folded = file.name.toLowerCase();
    const bucket = byName.get(folded);
    if (bucket) bucket.push(file);
    else byName.set(folded, [file]);
  }
  for (const [, bucket] of byName) {
    if (bucket.length < 2) continue;
    bucket.sort(
      (a, b) => moduleDirRank(a.rel) - moduleDirRank(b.rel) || a.rel.localeCompare(b.rel) || a.name.length - b.name.length || a.name.localeCompare(b.name)
    );
    const locations = [...new Set(bucket.map((f) => `${f.rel}/${f.name}`))].join(" and ");
    moduleNotes.push({
      id: `modules-dup-${bucket[0].name.toLowerCase()}`,
      label: "Modules",
      status: "warn",
      detail: `Duplicate module "${bucket[0].name}" at ${locations} — the converter keeps the copy in ${bucket[0].rel}/ and skips the others.`
    });
  }
  if (discovery.backups.length > 0) {
    const shown = discovery.backups.slice(0, 3).join(", ");
    const more = discovery.backups.length > 3 ? ` (+${discovery.backups.length - 3} more)` : "";
    moduleNotes.push({
      id: "modules-backups",
      label: "Modules",
      status: "warn",
      detail: `Backup leftovers will be skipped during conversion: ${shown}${more}.`
    });
  }
  const strays = discovery.files.filter((file) => !/\.prx$/i.test(file.name));
  if (strays.length > 0) {
    const shown = strays.slice(0, 3).map((f) => `${f.rel}/${f.name}`).join(", ");
    const more = strays.length > 3 ? ` (+${strays.length - 3} more)` : "";
    moduleNotes.push({
      id: "modules-strays",
      label: "Modules",
      status: "warn",
      detail: `Module-like files without a .prx name will still be converted: ${shown}${more}.`
    });
  }
  const badModuleNames = discovery.files.filter((file) => /[^\x20-\x7e]|[:$]/.test(file.name));
  if (badModuleNames.length > 0) {
    const shown = badModuleNames.slice(0, 3).map((f) => `${f.rel}/${f.name}`).join(", ");
    const more = badModuleNames.length > 3 ? ` (+${badModuleNames.length - 3} more)` : "";
    moduleNotes.push({
      id: "modules-filename",
      label: "Modules",
      status: "warn",
      detail: `The converter cannot use these module filenames on Windows: ${shown}${more}. They will be skipped so the rest of the game can still install; the game may fail to launch. Rename them inside the dump for the best result.`
    });
  }
  const selfModules = discovery.files.filter((file) => file.magic === "self");
  const needsPython = kind === "self" || selfModules.length > 0;
  let pythonReady = false;
  if (needsPython) {
    const python = await pythonInvocation();
    pythonReady = !!python;
    checks.push(
      python ? {
        id: "python",
        label: "Python",
        status: "pass",
        detail: python.bundled ? "Bundled Python is available for the SELF unwrap step." : "Python 3 available for the SELF unwrap step."
      } : {
        id: "python",
        label: "Python",
        status: "fail",
        detail: "The bundled Python is missing — repair or reinstall NovaPS5."
      }
    );
  }
  const needed = /* @__PURE__ */ new Set();
  const moduleSonames = [];
  const moduleUnwrapFailures = [];
  const collectElf = (elfPath) => {
    const info = readElfDynamicInfo(elfPath);
    if (!info) return;
    for (const name of info.needed) needed.add(name);
  };
  if ((!needsPython || pythonReady) && (kind === "self" || kind === "elf" || discovery.files.length > 0)) {
    const trialDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `novaps5-compat-${process.pid}-`));
    try {
      if (kind === "self") {
        try {
          const outElf = path.join(trialDir, "eboot.elf");
          await unwrapSelf(eboot, outElf);
          collectElf(outElf);
          checks.push({
            id: "unwrap",
            label: "Eboot unwrap",
            status: "pass",
            detail: "Trial unwrap succeeded — the executable converts cleanly."
          });
        } catch (error) {
          checks.push({
            id: "unwrap",
            label: "Eboot unwrap",
            status: "warn",
            detail: `The eboot cannot be converted: ${errorDetail(error)}. Installation will complete with the game marked Not working.`
          });
        }
      } else if (kind === "elf") {
        collectElf(eboot);
      }
      for (let i = 0; i < discovery.files.length; i++) {
        const file = discovery.files[i];
        try {
          const elfPath = file.magic === "self" ? path.join(trialDir, `module-${i}.elf`) : file.path;
          if (file.magic === "self") await unwrapSelf(file.path, elfPath);
          const info = readElfDynamicInfo(elfPath);
          if (!info) {
            if (file.magic === "self") {
              moduleUnwrapFailures.push(`${file.rel}/${file.name}: unreadable ELF`);
            }
            continue;
          }
          for (const name of info.needed) needed.add(name);
          if (info.soname) {
            moduleSonames.push({ soname: info.soname, file });
          }
        } catch (error) {
          moduleUnwrapFailures.push(`${file.rel}/${file.name}: ${errorDetail(error)}`);
        }
      }
    } finally {
      await fs.promises.rm(trialDir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
  if (moduleUnwrapFailures.length > 0) {
    const shown = moduleUnwrapFailures.slice(0, 3).join("; ");
    const more = moduleUnwrapFailures.length > 3 ? ` (+${moduleUnwrapFailures.length - 3} more)` : "";
    moduleNotes.push({
      id: "modules-unwrap",
      label: "Modules",
      status: "warn",
      detail: `Some modules cannot be converted and will be skipped: ${shown}${more}. Installation will continue so the rest of the game can install, but the game may fail to launch. Re-copy or re-extract the dump for the best chance.`
    });
  }
  const bySoname = /* @__PURE__ */ new Map();
  for (const entry of moduleSonames) {
    const key = entry.soname.toLowerCase();
    const bucket = bySoname.get(key);
    if (bucket) bucket.push(entry);
    else bySoname.set(key, [entry]);
  }
  for (const [, bucket] of bySoname) {
    if (bucket.length < 2) continue;
    bucket.sort(
      (a, b) => moduleDirRank(a.file.rel) - moduleDirRank(b.file.rel) || a.file.rel.localeCompare(b.file.rel) || a.file.name.length - b.file.name.length || a.file.name.localeCompare(b.file.name)
    );
    const locations = bucket.map((e) => `${e.file.rel}/${e.file.name}`).join(" and ");
    moduleNotes.push({
      id: `modules-soname-${bucket[0].soname.toLowerCase()}`,
      label: "Modules",
      status: "warn",
      detail: `Modules ${locations} share the identity "${bucket[0].soname}" — the converter keeps the copy in ${bucket[0].file.rel}/ and skips the others.`
    });
  }
  if (discovery.files.length > 0 && !moduleNotes.some((check) => check.status === "fail")) {
    const noteCount = moduleNotes.filter((check) => check.status !== "pass").length;
    const count = discovery.files.length;
    moduleNotes.push({
      id: "modules",
      label: "Modules",
      status: noteCount > 0 ? "warn" : "pass",
      detail: `${count} loadable module${count === 1 ? "" : "s"} found${noteCount > 0 ? " — the notes above are reconciled during conversion" : " — folders are consistent"}.`
    });
  }
  checks.push(...moduleNotes);
  const tools = toolingPresent();
  if (needed.size > 0 && tools.libs) {
    const provided = /* @__PURE__ */ new Set();
    try {
      for (const entry of fs.readdirSync(runtimeLibsDir(), { withFileTypes: true })) {
        if (entry.isFile()) provided.add(normalizeLibName(entry.name));
      }
    } catch {
    }
    for (const name of moduleFileNames) provided.add(normalizeLibName(name));
    for (const entry of moduleSonames) provided.add(normalizeLibName(entry.soname));
    const required = [...needed];
    const missing = required.filter((name) => !provided.has(normalizeLibName(name)));
    checks.push(
      missing.length > 0 ? {
        id: "deps",
        label: "Libraries",
        status: "warn",
        detail: `Requires libraries the conversion runtime does not provide: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` (+${missing.length - 4} more)` : ""} — the game may fail to launch.`
      } : {
        id: "deps",
        label: "Libraries",
        status: "pass",
        detail: `All ${required.length} required librar${required.length === 1 ? "y is" : "ies are"} provided by the runtime or the dump.`
      }
    );
  }
  checks.push(
    tools.relinker && tools.libs && tools.unwrap ? {
      id: "runtime",
      label: "Runtime",
      status: "pass",
      detail: "Conversion runtime is installed and ready."
    } : {
      id: "runtime",
      label: "Runtime",
      status: "fail",
      detail: "Conversion runtime is incomplete — restart NovaPS5 to download it."
    }
  );
  const meta = await readMeta(root);
  checks.push(
    meta.titleId ? {
      id: "meta",
      label: "Metadata",
      status: "pass",
      detail: `Title detected: ${meta.name} (${meta.titleId}).`
    } : {
      id: "meta",
      label: "Metadata",
      status: "warn",
      detail: "Title metadata unreadable — the folder name will be used."
    }
  );
  return { checks, compatible: checks.every((check) => check.status !== "fail") };
}
function formatBlockers(report) {
  const blockers = report.checks.filter((check) => check.status === "fail");
  if (blockers.length === 0) return null;
  return blockers.map((check) => `${check.label}: ${check.detail}`).join(" ");
}
const PENALIZED_ROOT = /(^|[\\/])(update|updates|patch|patches|dlc|bonus|preorder)([\\/]|$)/i;
async function findDumpRoot(dir, depth, maxDepth) {
  if (depth > maxDepth) return null;
  const hasEboot = fs.existsSync(path.join(dir, "eboot.bin"));
  const hasSceSys = fs.existsSync(path.join(dir, "sce_sys"));
  const penalty = PENALIZED_ROOT.test(dir) ? 100 : 0;
  if (hasEboot) return { path: dir, score: 1e3 - depth - penalty, hasEboot };
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return hasSceSys ? { path: dir, score: 100 - depth - penalty, hasEboot } : null;
  }
  const children = entries.filter(
    (entry) => entry.isDirectory() && entry.name !== "sce_sys" && entry.name !== "__MACOSX" && !entry.name.startsWith(".")
  ).sort(
    (a, b) => Number(PENALIZED_ROOT.test(a.name)) - Number(PENALIZED_ROOT.test(b.name)) || a.name.localeCompare(b.name)
  );
  let best = hasSceSys ? { path: dir, score: 100 - depth - penalty, hasEboot } : null;
  for (const entry of children) {
    const found = await findDumpRoot(path.join(dir, entry.name), depth + 1, maxDepth);
    if (!found) continue;
    if (found.hasEboot && !PENALIZED_ROOT.test(found.path)) return found;
    if (!best || found.score > best.score) best = found;
  }
  return best;
}
async function locateDumpRoot(dir, depth = 0) {
  const found = await findDumpRoot(dir, depth, 6);
  return found?.path ?? null;
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
function sourceFallbackName(sourcePath) {
  return path.basename(sourcePath).replace(/\.(zip|rar|7z|tar|tgz|tar\.gz|tar\.xz)$/i, "");
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
      if (name === path.basename(sourceDir)) {
        const localized = Object.entries(sfo).find(
          ([key, value]) => /^TITLE_[A-Z]{2}$/i.test(key) && value.trim()
        )?.[1];
        const title = sfo.TITLE?.trim() || localized?.trim();
        if (title) name = title;
      }
    } catch {
    }
  }
  for (const candidate of ["icon0.png", "pic0.png", "pic1.png"]) {
    try {
      await fs.promises.access(path.join(sourceDir, "sce_sys", candidate));
      hasCover = true;
      break;
    } catch {
    }
  }
  return { name, titleId, hasCover };
}
async function extractArchive(archive, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  let detail = "";
  try {
    const result = await run("tar", ["-xf", archive, "-C", dest], {
      timeoutMs: 30 * 60 * 1e3
    });
    if (result.code === 0 && !result.timedOut) return;
    detail = result.timedOut ? "extraction timed out after 30 minutes" : result.stderr.trim() || `tar exited with code ${result.code}`;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  if (process.platform === "win32" && /\.zip$/i.test(archive)) {
    const esc = (p) => p.replace(/'/g, "''");
    try {
      const result = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Expand-Archive -LiteralPath '${esc(archive)}' -DestinationPath '${esc(dest)}' -Force`
        ],
        { timeoutMs: 30 * 60 * 1e3 }
      );
      if (result.code === 0 && !result.timedOut) return;
      detail = result.stderr.trim() || detail;
    } catch (error) {
      detail = error instanceof Error ? error.message : detail;
    }
  }
  if (/no space left|not enough space|disk full|ENOSPC/i.test(detail)) {
    throw new Error(
      `Not enough free space to extract "${path.basename(archive)}" — archives are unpacked to the system temp folder (${electron.app.getPath("temp")}) first. Free space on that drive, or extract the archive yourself and import the folder.`
    );
  }
  if (/passphrase|password|encrypted/i.test(detail)) {
    throw new Error(
      `The archive is password-protected — extract "${path.basename(archive)}" first, then import the folder.`
    );
  }
  if (/unrecognized archive format|not supported|unsupported/i.test(detail)) {
    throw new Error(
      `The archive format could not be read — extract "${path.basename(archive)}" with an archive tool, then import the extracted folder.`
    );
  }
  throw new Error(
    `Could not extract "${path.basename(archive)}" — ${detail || "the extractor produced no output"}`
  );
}
async function resolveSource(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`The selected source no longer exists: ${sourcePath}`);
  }
  if (/\.(zip|rar|7z|tar|tgz|tar\.gz|tar\.xz)$/i.test(sourcePath)) {
    const tempDir = path.join(
      electron.app.getPath("temp"),
      `ps5lib-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    );
    try {
      await extractArchive(sourcePath, tempDir);
    } catch (error) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
      });
      throw error;
    }
    const root2 = await locateDumpRoot(tempDir) ?? tempDir;
    return { root: root2, tempDir };
  }
  let sourceIsFile = false;
  try {
    sourceIsFile = (await fs.promises.stat(sourcePath)).isFile();
  } catch {
  }
  if (sourceIsFile) {
    throw new Error(
      `"${path.basename(sourcePath)}" is not a supported archive — use .zip, .rar, .7z, .tar, .tar.gz, or .tar.xz.`
    );
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
    const displayName = resolved.tempDir && meta.name === path.basename(root) ? sourceFallbackName(sourcePath) : meta.name;
    let sizeBytes = 0;
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (entry.name.endsWith(".esbak")) continue;
      sizeBytes += await dirSize(path.join(root, entry.name));
    }
    const compat = await checkCompatibility(root);
    return {
      isDump: true,
      name: displayName,
      titleId: meta.titleId,
      hasCover: meta.hasCover,
      sizeBytes,
      checks: compat.checks,
      compatible: compat.compatible
    };
  } catch (error) {
    return { isDump: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
const LOG_PREFIX = "novaps5-launch-";
function describeCode(code) {
  const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`;
  const names = {
    3221225477: "access violation",
    3221225480: "invalid handle",
    3221225501: "illegal instruction",
    3221225595: "invalid image format",
    3221225620: "divide by zero",
    3221225781: "required DLL not found",
    3221225786: "terminated (Ctrl+C or logoff)",
    3221225794: "DLL initialization failed",
    3221226505: "stack buffer overrun / fail-fast",
    3221226519: "invalid parameter / fail-fast"
  };
  const name = names[code >>> 0];
  return name ? `${hex} — ${name}` : hex;
}
function describeRuntimeFailure(text) {
  const cpuLacks = text.match(/host CPU\s+[^:\n]*:\s*has[^;\n]*;\s*lacks\s+([^\r\n]+)/i);
  if (cpuLacks) {
    const missing = cpuLacks[1].trim();
    if (missing && !/^(none|nothing)\b/i.test(missing)) {
      return `this PC's CPU lacks ${missing} — the PS5 title needs those instructions`;
    }
  }
  const cpuHost = text.match(/The host CPU \(([^)]+)\)/i);
  if (cpuHost) {
    return `this PC's CPU (${cpuHost[1]}) cannot run instructions the PS5 title uses`;
  }
  const missingModule = text.match(/FAIL:\s*dependency module not found:\s*([^\r\n]+)/i);
  if (missingModule) {
    const missing = missingModule[1].trim().replace(/^["']|["']$/g, "");
    return `could not load dependency "${path.basename(missing)}" — it is missing from the install`;
  }
  const unresolved = text.match(/FAIL:\s*unresolved dependency import([\s\S]{0,500})/i);
  if (unresolved) {
    const block = unresolved[1];
    const provider = block.match(/Provider:\s*([^\r\n]+)/i)?.[1]?.trim();
    const symbol = block.match(/Symbol:\s*([^\r\n]+)/i)?.[1]?.trim();
    if (symbol && provider) {
      return `the game needs "${symbol}" from "${path.basename(provider)}", which the runtime does not provide yet`;
    }
    if (symbol) return `the game needs the imported function "${symbol}", which the runtime does not provide yet`;
    return "the game imports a function the conversion runtime does not implement yet";
  }
  const unresolvedElf = [
    ...text.matchAll(/FAIL:\s*unresolved ELF import\s+(\S+)(?:\s+from\s+(\S+))?/gi)
  ];
  if (unresolvedElf.length > 0) {
    const symbols = new Set(unresolvedElf.map((match) => match[1]));
    const providers = [
      ...new Set(
        unresolvedElf.map((match) => match[2]).filter((value) => Boolean(value)).map((value) => path.basename(value))
      )
    ].sort();
    const imports = `${symbols.size} function${symbols.size === 1 ? "" : "s"}`;
    const from = providers.length > 0 ? ` from ${providers.join(", ")}` : "";
    return `the game asks for ${imports}${from} that the AnyPS5 runtime does not implement — the converted entry point aborts before the title runs`;
  }
  if (/GetLastError:\s*127\b/i.test(text)) {
    return "Windows could not resolve a function the converted game imports (error 127) — the AnyPS5 runtime does not export it";
  }
  const notPe = text.match(/FAIL:\s*dependency module is not a Windows PE image:\s*([^\r\n]+)/i);
  if (notPe) {
    return `"${path.basename(notPe[1].trim())}" is not a valid Windows library — the install is corrupted`;
  }
  if (/FAIL:\s*invalid or unsupported PE dependency metadata/i.test(text)) {
    return "the converted executable has unreadable dependency metadata — retry the installation";
  }
  if (/FAIL:\s*dependency diagnostics capacity exceeded/i.test(text)) {
    return "the game has too many dependencies for the runtime to diagnose";
  }
  if (/FAIL:\s*dependency diagnostics Windows API failed/i.test(text)) {
    return "Windows could not inspect the game’s dependencies during startup";
  }
  const trophy = detectTrophyAbort(text);
  if (trophy) {
    const packageName = path.basename(trophy.packagePath);
    return `the game asked for trophy ${trophy.trophyId}, which ${packageName} does not define — the AnyPS5 runtime aborts instead of returning the invalid-trophy error (hide the trophy package to run with placeholder trophy data)`;
  }
  return null;
}
function detectTrophyAbort(text) {
  const match = text.match(
    /sceNpTrophy2GetTrophyInfo:\s*trophy\s+(\d+)\s+is not in\s+([^\r\n]+)/i
  );
  if (!match) return null;
  return { trophyId: Number(match[1]), packagePath: match[2].trim() };
}
function summarizeExit(code, signal, logPath) {
  let text = "";
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
  }
  const trophyAbort = detectTrophyAbort(text);
  const diagnosis = describeRuntimeFailure(text);
  if (diagnosis) return { detail: diagnosis, trophyAbort };
  const fatal = text.match(
    /^FATAL: unhandled exception (0x[0-9a-f]+)[^\n]*?on thread \d+ '([^']*)'/im
  );
  const rip = text.match(/^\s*rip \S+ (\S+)/m);
  if (fatal) {
    const fault = describeCode(parseInt(fatal[1], 16));
    const where = rip ? ` at ${rip[1]}` : "";
    const thread = fatal[2] ? `, thread '${fatal[2]}'` : "";
    return { detail: `crashed (${fault})${where}${thread}`, trophyAbort };
  }
  if (signal) return { detail: `killed by ${signal}`, trophyAbort };
  if (code === null) return { detail: "exited without an exit code", trophyAbort };
  if (code === 0) return { detail: "exited immediately with code 0", trophyAbort };
  if (code < 0 || code >= 3221225472) {
    return { detail: `crashed (${describeCode(code)})`, trophyAbort };
  }
  const tail = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" · ");
  return {
    detail: tail ? `exited with code ${code} — ${tail}` : `exited with code ${code}`,
    trophyAbort
  };
}
async function probeLaunch(exePath, cwd, ms = 1e4) {
  try {
    const tmp = os.tmpdir();
    const cutoff = Date.now() - 60 * 60 * 1e3;
    for (const file of fs.readdirSync(tmp)) {
      if (!file.startsWith(LOG_PREFIX)) continue;
      const full = path.join(tmp, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
      }
    }
  } catch {
  }
  const logPath = path.join(
    os.tmpdir(),
    `${LOG_PREFIX}${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`
  );
  let logFd = null;
  try {
    logFd = fs.openSync(logPath, "w");
  } catch {
    logFd = null;
  }
  const closeLog = () => {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
      }
      logFd = null;
    }
  };
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (probe2) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      closeLog();
      try {
        fs.rmSync(logPath, { force: true });
      } catch {
      }
      resolve(probe2);
    };
    let child;
    try {
      child = child_process.spawn(exePath, [], {
        cwd,
        detached: true,
        stdio: logFd !== null ? ["ignore", logFd, logFd] : "ignore",
        windowsHide: false
      });
    } catch (error) {
      finish({ state: "failed", detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.on("error", (error) => {
      finish({ state: "failed", detail: error.message });
    });
    child.unref();
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      setTimeout(() => {
        const summary = summarizeExit(code, signal, logPath);
        finish({ state: "failed", detail: summary.detail, trophyAbort: summary.trophyAbort });
      }, 150);
    });
    timer = setTimeout(() => {
      finish({ state: "works", detail: `still running after ${Math.round(ms / 1e3)}s` });
    }, ms);
  });
}
function isBackup(name) {
  return name.endsWith(".esbak");
}
const RELINK_PROGRESS = {
  Executable: [68, 1],
  "Syscall scan": [70, 3],
  "Instruction scan": [73, 3],
  "Instruction conversion": [68, 2],
  "Import analysis": [79, 1],
  "PRX conversion": [80, 5],
  "Output image": [85, 2],
  "Write output": [87, 1]
};
async function freeSpace(dir) {
  try {
    const stats = await fs.promises.statfs(dir);
    const available = Number(stats.bavail || stats.bfree || 0) * Number(stats.bsize || 0);
    return Number.isFinite(available) && available > 0 ? available : null;
  } catch {
    return null;
  }
}
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
function identifyOffendingModules(detail, output, modules, sonames) {
  const inputLines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^Input:/i.test(line));
  const haystack = `${detail}
${inputLines.join("\n")}`.toLowerCase();
  const found = /* @__PURE__ */ new Set();
  for (const file of modules) {
    const name = file.name.toLowerCase();
    if (name.length >= 4 && haystack.includes(name)) found.add(file.name);
    const soname = sonames.get(file)?.toLowerCase();
    if (soname && soname.length >= 4 && haystack.includes(soname)) found.add(file.name);
  }
  for (const match of haystack.matchAll(/([^\s"'\\/]+?)\.guest\.prx/g)) {
    const base = match[1];
    const hit = modules.find((file) => file.name.toLowerCase() === base);
    if (hit) found.add(hit.name);
  }
  return [...found];
}
const activeStages = /* @__PURE__ */ new Set();
async function installGame(sourcePath, nameOverride, report, jobId) {
  let step = "validating";
  let percent = 0;
  let tempDir = null;
  let stageDir = null;
  let id = "";
  let name = "";
  let metaTitleId = null;
  let persistentSource = "";
  let finalDir = "";
  let exeName = "";
  let phase = "pre";
  const emit = (message, pct, s) => {
    step = s;
    percent = Math.round(pct);
    report({ jobId, step, message, percent, status: "running" });
  };
  const registerFailed = async (reason) => {
    const stage = stageDir;
    if (!stage || !finalDir || !id || !name) return null;
    const prior = await getGame(id);
    if (prior?.status === "ready" && fs.existsSync(prior.exePath)) return null;
    emit("Conversion failed — keeping the install for retry…", 92, "finalizing");
    let retire = `${finalDir}.old`;
    await fs.promises.rm(retire, { recursive: true, force: true }).catch(() => {
    });
    if (fs.existsSync(retire)) retire = `${finalDir}.old-${Date.now()}`;
    if (fs.existsSync(finalDir)) await fs.promises.rename(finalDir, retire);
    try {
      await fs.promises.rename(stage, finalDir);
    } catch (swapError) {
      if (fs.existsSync(retire)) await fs.promises.rename(retire, finalDir).catch(() => {
      });
      throw swapError;
    }
    await fs.promises.rm(retire, { recursive: true, force: true }).catch(() => {
    });
    activeStages.delete(path.basename(stage));
    stageDir = null;
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
      });
      tempDir = null;
    }
    const sizeBytes = await dirSize(finalDir);
    let cover = null;
    for (const candidate of ["icon0.png", "pic0.png", "pic1.png"]) {
      try {
        await fs.promises.copyFile(
          path.join(finalDir, "sce_sys", candidate),
          path.join(finalDir, "cover.png")
        );
        cover = "cover.png";
        break;
      } catch {
        try {
          await fs.promises.copyFile(
            path.join(finalDir, "app0", "sce_sys", candidate),
            path.join(finalDir, "cover.png")
          );
          cover = "cover.png";
          break;
        } catch {
        }
      }
    }
    const detail = reason.trim().replace(/^Conversion failed\s*—\s*/i, "") || "the converter could not produce an executable";
    const game = {
      id,
      name,
      titleId: metaTitleId,
      sourcePath: persistentSource,
      installPath: finalDir,
      exePath: path.join(finalDir, exeName),
      sizeBytes,
      cover,
      status: "error",
      error: `Conversion failed — ${detail}`,
      installedAt: Date.now(),
      launchState: "failed",
      launchDetail: detail
    };
    await addGame(game);
    report({
      jobId,
      step: "done",
      message: "Installed — conversion failed, kept for retry",
      percent: 100,
      status: "done",
      gameId: id,
      gameName: name,
      launchState: "failed",
      launchDetail: detail,
      conversionFailed: true
    });
    return game;
  };
  try {
    emit("Validating source…", 2, "validating");
    const resolved = await resolveSource(sourcePath);
    tempDir = resolved.tempDir;
    const dumpRoot = resolved.root;
    persistentSource = resolved.tempDir ? sourcePath : dumpRoot;
    if (!fs.existsSync(path.join(dumpRoot, "eboot.bin"))) {
      throw new Error("No eboot.bin found — this does not look like a PS5 game dump.");
    }
    emit("Checking compatibility…", 4, "validating");
    const compat = await checkCompatibility(dumpRoot);
    const blockers = formatBlockers(compat);
    if (blockers) throw new Error(`Not compatible — ${blockers}`);
    const meta = await readMeta(dumpRoot);
    metaTitleId = meta.titleId;
    const fallbackName = resolved.tempDir && meta.name === path.basename(dumpRoot) ? sourceFallbackName(sourcePath) : meta.name;
    name = (nameOverride?.trim() || fallbackName).slice(0, 90);
    let safeName = name.replace(/[\\/:*?"<>|]/g, "").trim() || "game";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safeName)) safeName += "_";
    exeName = `${safeName}.exe`;
    const baseId = slugify(name);
    const owned = await getGame(baseId);
    const sameTitle = !!owned && (!!meta.titleId && owned.titleId === meta.titleId || owned.status === "error" && owned.name === name);
    id = baseId;
    if (!sameTitle) {
      let n = 2;
      const taken = async (candidate) => !!await getGame(candidate) || fs.existsSync(path.join(gamesRoot(), candidate));
      while (await taken(id)) id = `${baseId}-${n++}`;
    }
    finalDir = path.join(gamesRoot(), id);
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
      (entry) => !isBackup(entry.name) && !isBackupName(entry.name)
    );
    let total = 0;
    for (const entry of entries) total += await dirSize(path.join(dumpRoot, entry.name));
    const existingSize = fs.existsSync(finalDir) ? await dirSize(finalDir) : 0;
    const free = await freeSpace(gamesRoot());
    if (free !== null && total > 0 && free < total + existingSize + 256 * 1024 * 1024) {
      throw new Error(
        `Not enough free space — this game needs about ${formatBytes(total + existingSize)} but only ${formatBytes(free)} is available on the games drive. Free some space and retry.`
      );
    }
    let copied = 0;
    let lastCopyEmit = 0;
    emit("Copying game data…", 8, "copying");
    for (const entry of entries) {
      const src = path.join(dumpRoot, entry.name);
      const dest = path.join(installDir, entry.name);
      const tick = (n) => {
        copied += n;
        const pct = total > 0 ? 8 + Math.min(42, copied / total * 42) : 8;
        const now = Date.now();
        if (pct - percent >= 1 || now - lastCopyEmit > 400) {
          lastCopyEmit = now;
          emit(`Copying ${entry.name}…`, pct, "copying");
        }
      };
      if (entry.isDirectory()) {
        await copyDir(src, dest, tick);
        continue;
      }
      try {
        const followed = await fs.promises.stat(src);
        if (followed.isDirectory()) {
          await copyDir(src, dest, tick);
        } else {
          for (let attempt = 0; ; attempt++) {
            try {
              await fs.promises.copyFile(src, dest);
              tick(followed.size);
              break;
            } catch (error) {
              const code = error.code;
              if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") break;
              if (attempt < 2 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
                await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
                continue;
              }
              throw error;
            }
          }
        }
      } catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") continue;
        throw new Error(
          `Could not copy "${entry.name}" from the dump — ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    phase = "converting";
    const ebootDest = path.join(installDir, "eboot.bin");
    const inputElf = path.join(installDir, "input.elf");
    if (detectContainer(ebootDest) === "unknown") {
      const sourceEboot = path.join(dumpRoot, "eboot.bin");
      if (detectContainer(sourceEboot) !== "unknown") {
        await fs.promises.copyFile(sourceEboot, ebootDest);
      }
    }
    const ebootKind = detectContainer(ebootDest);
    if (ebootKind === "self") {
      emit("Unwrapping eboot (SELF → ELF)…", 55, "unwrapping-eboot");
      await unwrapSelf(ebootDest, inputElf);
    } else if (ebootKind === "elf") {
      await fs.promises.copyFile(ebootDest, inputElf);
    } else if (ebootKind === "pe") {
      throw new Error(
        "eboot.bin is a Windows executable, not a PS5 dump — this folder looks already converted. Import the original dump folder instead."
      );
    } else {
      throw new Error(
        "eboot.bin is neither a plain ELF nor a SELF container — the dump file is corrupted or incomplete."
      );
    }
    emit("Preparing modules…", 60, "preparing-modules");
    const singularDir = path.join(installDir, "sce_module");
    const pluralDir = path.join(installDir, "sce_modules");
    if (fs.existsSync(singularDir) && fs.existsSync(pluralDir)) {
      for (const entry of await fs.promises.readdir(pluralDir, { withFileTypes: true })) {
        const from = path.join(pluralDir, entry.name);
        const to = path.join(singularDir, entry.name);
        if (fs.existsSync(to)) await fs.promises.rm(from, { recursive: true, force: true });
        else await fs.promises.rename(from, to);
      }
      await fs.promises.rm(pluralDir, { recursive: true, force: true });
    }
    const modules = await discoverModuleFiles(installDir);
    if (modules.shims.length > 0) {
      const folders = [...new Set(modules.shims.map((file) => file.rel))].join(", ");
      console.info(
        `[install] leaving ${modules.shims.length} stand-in system librar${modules.shims.length === 1 ? "y" : "ies"} in ${folders} unconverted — the runtime provides its own implementations`
      );
    }
    const skippedModules = [];
    for (const rel of modules.leftovers) {
      await fs.promises.rm(path.join(installDir, rel), { force: true }).catch(() => {
      });
    }
    const preferred = (candidate, current) => {
      if (!current) return true;
      const rank = moduleDirRank(candidate.rel) - moduleDirRank(current.rel);
      if (rank !== 0) return rank < 0;
      if (candidate.rel !== current.rel) return candidate.rel < current.rel;
      if (candidate.name.length !== current.name.length) {
        return candidate.name.length < current.name.length;
      }
      return candidate.name.localeCompare(current.name) < 0;
    };
    const candidates = [];
    for (const file of modules.files) {
      if (!fs.existsSync(file.path)) continue;
      if (/[^\x20-\x7e]|[:$]/.test(file.name)) {
        console.warn(`[install] skipping module with unsupported filename: ${file.rel}/${file.name}`);
        skippedModules.push(`${file.rel}/${file.name}`);
        await fs.promises.rm(file.path, { force: true }).catch(() => {
        });
        continue;
      }
      candidates.push(file);
    }
    const byName = /* @__PURE__ */ new Map();
    for (const file of candidates) {
      const key = file.name.toLowerCase();
      if (preferred(file, byName.get(key))) byName.set(key, file);
    }
    for (const file of candidates) {
      if (byName.get(file.name.toLowerCase()) !== file) {
        await fs.promises.rm(file.path, { force: true }).catch(() => {
        });
      }
    }
    const keptByName = candidates.filter((file) => fs.existsSync(file.path));
    for (const file of keptByName) {
      if (file.magic !== "self") continue;
      emit(`Unwrapping ${file.name}…`, 60, "preparing-modules");
      try {
        await unwrapSelf(file.path, file.path);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[install] skipping module "${file.rel}/${file.name}" — ${detail}`);
        skippedModules.push(`${file.rel}/${file.name}`);
        await fs.promises.rm(file.path, { force: true }).catch(() => {
        });
      }
    }
    const survivors = keptByName.filter((file) => fs.existsSync(file.path));
    const sonames = /* @__PURE__ */ new Map();
    for (const file of survivors) {
      sonames.set(file, readElfDynamicInfo(file.path)?.soname ?? null);
    }
    const bySoname = /* @__PURE__ */ new Map();
    for (const file of survivors) {
      const soname = sonames.get(file);
      if (!soname) continue;
      const key = soname.toLowerCase();
      if (preferred(file, bySoname.get(key))) bySoname.set(key, file);
    }
    for (const file of survivors) {
      const soname = sonames.get(file);
      if (!soname) continue;
      if (bySoname.get(soname.toLowerCase()) !== file) {
        await fs.promises.rm(file.path, { force: true }).catch(() => {
        });
      }
    }
    const moduleFiles = survivors.filter((file) => fs.existsSync(file.path));
    const moduleDirs = [...new Set(moduleFiles.map((file) => file.rel))].filter((rel) => {
      const key = rel.replace(/\\/g, "/").toLowerCase();
      return key !== "sce_module" && key !== "sce_modules" && key !== "prx";
    }).sort((a, b) => moduleDirRank(a) - moduleDirRank(b) || a.localeCompare(b));
    const hasStandardDir = ["sce_module", "sce_modules", "prx"].some((dir) => {
      try {
        return fs.statSync(path.join(installDir, dir)).isDirectory();
      } catch {
        return false;
      }
    });
    if (!hasStandardDir && moduleDirs.length === 0) {
      const target = path.join(installDir, "sce_module");
      if (fs.existsSync(target)) {
        throw new Error(
          'A file named "sce_module" is in the way of the module folder — remove or rename it in the dump and retry.'
        );
      }
      await fs.promises.mkdir(target, { recursive: true });
    }
    const modDir = path.join(installDir, "sce_module");
    emit("Converting to a Windows executable…", 68, "relinking");
    const exePath = path.join(installDir, exeName);
    let relinkTail = "";
    let relinkMapped = 68;
    const onRelinkOutput = (chunk) => {
      const frames = (relinkTail + chunk).split(/[\r\n]/);
      relinkTail = frames.pop() ?? "";
      for (const frame of frames) {
        const match = frame.match(
          /(Executable|PRX conversion|Syscall scan|Instruction scan|Instruction conversion|Import analysis|Output image|Write output)\s*\|\s*[^|]*\|\s*(\d{1,3})%/
        );
        if (!match) continue;
        const slice = RELINK_PROGRESS[match[1]];
        if (!slice) continue;
        const [base, span] = slice;
        const stagePercent = Math.min(100, Number(match[2]));
        const mapped = Math.min(88, base + span * stagePercent / 100);
        relinkMapped = Math.max(relinkMapped, mapped);
        emit(`Converting — ${match[1].toLowerCase()} ${stagePercent}%`, relinkMapped, "relinking");
      }
    };
    const runRelink = (excludeModules = []) => relink(inputElf, exePath, {
      cwd: installDir,
      moduleDirs,
      windowsDiagnostics: true,
      onOutput: onRelinkOutput,
      excludeModules
    });
    const relinkBestEffort = async () => {
      try {
        return await runRelink();
      } catch (error) {
        if (!(error instanceof RelinkError) || !/guest|module/i.test(error.detail)) throw error;
        let lastError = error;
        const names = identifyOffendingModules(error.detail, error.output, moduleFiles, sonames);
        if (names.length > 0) {
          emit(
            `Conversion failed — retrying without ${names.length === 1 ? names[0] : `${names.length} module files`}…`,
            68,
            "relinking"
          );
          for (const name2 of names) if (!skippedModules.includes(name2)) skippedModules.push(name2);
          try {
            return await runRelink(names);
          } catch (retryError) {
            if (!(retryError instanceof RelinkError)) throw retryError;
            lastError = retryError;
          }
        }
        const allNames = [...new Set(moduleFiles.map((file) => file.name))];
        const alreadyExcludedAll = names.length > 0 && allNames.every((name2) => names.includes(name2));
        if (allNames.length > 0 && !alreadyExcludedAll) {
          emit("Conversion failed — retrying without bundled modules…", 68, "relinking");
          for (const name2 of allNames) if (!skippedModules.includes(name2)) skippedModules.push(name2);
          try {
            return await runRelink(allNames);
          } catch (retryError) {
            if (!(retryError instanceof RelinkError)) throw retryError;
            lastError = retryError;
          }
        }
        throw lastError;
      }
    };
    const relinked = await relinkBestEffort();
    if (relinked.skippedSelf.length > 0) {
      console.warn(
        `[install] relinker skipped SELF containers: ${relinked.skippedSelf.join(", ")}`
      );
    }
    if (!fs.existsSync(exePath)) {
      throw new Error(
        "Conversion finished without producing an executable — the dump is incomplete or the converter was interrupted. Retry the installation."
      );
    }
    if (detectContainer(exePath) !== "pe") {
      throw new Error(
        "Conversion produced a file that is not a Windows executable — the converter output is corrupted. Retry the installation."
      );
    }
    for (const file of moduleFiles) {
      await fs.promises.rm(file.path, { force: true }).catch(() => {
      });
    }
    emit("Building runtime layout…", 88, "building-layout");
    await buildLayout(installDir, [
      path.basename(exePath),
      "cover.png",
      // AnyPS5's startup dependency report — keep it next to the exe for
      // support instead of burying it under app0.
      "windows-diagnostics-imports.txt"
    ]);
    if (!fs.existsSync(path.join(installDir, "app0"))) {
      throw new Error(
        "The runtime app0/ folder was not created — the conversion was incomplete. Retry the installation."
      );
    }
    phase = "converted";
    let cover = null;
    for (const candidate of ["icon0.png", "pic0.png", "pic1.png"]) {
      try {
        await fs.promises.copyFile(
          path.join(installDir, "app0", "sce_sys", candidate),
          path.join(installDir, "cover.png")
        );
        cover = "cover.png";
        break;
      } catch {
      }
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
    let retire = `${finalDir}.old`;
    await fs.promises.rm(retire, { recursive: true, force: true }).catch(() => {
    });
    if (fs.existsSync(retire)) retire = `${finalDir}.old-${Date.now()}`;
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
    emit("Launch test — starting the game…", 97, "launch-test");
    let probe2 = { state: "failed", detail: "the launch test could not start" };
    try {
      probe2 = await probeLaunch(path.join(finalDir, path.basename(exePath)), finalDir);
    } catch (error) {
      probe2 = { state: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    const skipped = [.../* @__PURE__ */ new Set([...relinked.skippedSelf, ...skippedModules])];
    if (probe2.state === "failed" && skipped.length > 0) {
      const listed = skipped.slice(0, 3).join(", ");
      const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
      const hint = relinked.skippedSelf.length > 0 ? "decrypt the dump and retry for the best chance" : "re-copy or re-extract the dump for the best chance";
      probe2 = {
        ...probe2,
        detail: `${probe2.detail} — the converter skipped ${skipped.length === 1 ? "a module" : `${skipped.length} modules`} (${listed}${more}); ${hint}.`
      };
    }
    let compatibility;
    if (probe2.state === "failed" && probe2.trophyAbort) {
      const trophyId = probe2.trophyAbort.trophyId;
      emit("Launch test — retrying with placeholder trophy data…", 98, "launch-test");
      const hidden = await setTrophyDataMode(finalDir, "placeholders");
      if (hidden.changed.length > 0) {
        compatibility = { trophyData: "placeholders" };
        try {
          probe2 = await probeLaunch(path.join(finalDir, path.basename(exePath)), finalDir);
        } catch (error) {
          probe2 = {
            state: "failed",
            detail: error instanceof Error ? error.message : String(error)
          };
        }
        if (probe2.state === "works") {
          probe2 = {
            ...probe2,
            detail: `${probe2.detail} — trophy data hidden: the runtime aborts on trophy ${trophyId}, which the game's own trophy package does not define`
          };
        }
      } else if (hidden.error) {
        probe2 = {
          ...probe2,
          detail: `${probe2.detail}; could not hide the trophy package: ${hidden.error}`
        };
      }
    }
    const sizeBytes = await dirSize(finalDir);
    const game = {
      id,
      name,
      titleId: meta.titleId,
      sourcePath: persistentSource,
      installPath: finalDir,
      exePath: path.join(finalDir, path.basename(exePath)),
      sizeBytes,
      cover,
      status: "ready",
      installedAt: Date.now(),
      launchState: probe2.state,
      launchDetail: probe2.detail,
      ...compatibility ? { compatibility } : {}
    };
    await addGame(game);
    report({
      jobId,
      step: "done",
      message: probe2.state === "works" ? "Installed — launch test passed, the game is running" : "Installed — launch test failed",
      percent: 100,
      status: "done",
      gameId: id,
      gameName: name,
      launchState: probe2.state,
      launchDetail: probe2.detail
    });
    return game;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === "converting") {
      try {
        const game = await registerFailed(message);
        if (game) return game;
      } catch (fallbackError) {
        console.warn(
          `[install] could not keep the failed conversion: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
        );
      }
    }
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
    });
    if (stageDir) {
      activeStages.delete(path.basename(stageDir));
      await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {
      });
    }
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
function requestBuffer(url2, headers, timeoutMs, redirect = 0) {
  return new Promise((resolve, reject) => {
    const request = electron.net.request(url2);
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
          resolve(requestBuffer(new URL(location, url2).toString(), headers, timeoutMs, redirect + 1));
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
async function fetchHtml(url2) {
  const response = await requestBuffer(
    url2,
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
function downloadFile(url2, dest, onPercent, redirect = 0) {
  return new Promise((resolve, reject) => {
    const request = electron.net.request(url2);
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
        downloadFile(new URL(location, url2).toString(), dest, onPercent, redirect + 1).then(
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
    const probe2 = path.join(current, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe2, "");
    fs.rmSync(probe2, { force: true });
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
let quitting = false;
function beginQuit() {
  quitting = true;
}
function isQuitting() {
  return quitting;
}
function cancelQuit() {
  quitting = false;
}
const DEV_UPDATES = process.env.NOVAPS5_DEV_UPDATES === "1";
const CAN_CHECK = () => electron.app.isPackaged || DEV_UPDATES;
let getWindow = null;
let state = { status: "idle", currentVersion: electron.app.getVersion() };
let checking = null;
function storePath() {
  return path$1.join(electron.app.getPath("userData"), "updates.json");
}
function readStore() {
  try {
    const raw = fs$1.readFileSync(storePath(), "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function writeStore(store) {
  try {
    const file = storePath();
    fs$1.mkdirSync(path$1.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs$1.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs$1.renameSync(tmp, file);
  } catch {
  }
}
function publish(patch) {
  state = { ...state, currentVersion: electron.app.getVersion(), ...patch };
  getWindow?.()?.webContents.send("update:state", state);
  return state;
}
function updateState() {
  return state;
}
function notesOf(info) {
  const notes = info.releaseNotes;
  if (!notes) return "";
  if (typeof notes === "string") return notes;
  return notes.map((entry) => entry.version ? `## ${entry.version}

${entry.note ?? ""}` : entry.note ?? "").join("\n\n").trim();
}
function explain(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const code = error?.code ?? "";
  if (code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" || code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" || /no published versions|unable to find latest version|production release exists/i.test(raw)) {
    return {
      status: "current",
      message: "No updates published yet",
      detail: "There is no published NovaPS5 release to compare this version with yet."
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENETUNREACH|ERR_PROXY/i.test(raw)) {
    return {
      status: "error",
      message: "No internet connection",
      detail: "NovaPS5 could not reach GitHub to look for updates."
    };
  }
  if (/ETIMEDOUT|timeout|ERR_CONNECTION/i.test(raw)) {
    return { status: "error", message: "Update check timed out", detail: "The update server did not answer in time." };
  }
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || code === "ERR_UPDATER_INVALID_UPDATE_INFO" || code === "ERR_UPDATER_INVALID_RELEASE_FEED") {
    return {
      status: "error",
      message: "Release is incomplete",
      detail: "The GitHub release is missing its latest.yml update file, so NovaPS5 cannot verify the download. Attach NovaPS5-Setup-<version>.exe, latest.yml and its .blockmap to the release."
    };
  }
  if (code === "ERR_UPDATER_INVALID_SIGNATURE") {
    return {
      status: "error",
      message: "Update could not be verified",
      detail: "The downloaded installer does not match what the release published."
    };
  }
  if (/not packed|dev update config|dev-app-update/i.test(raw)) {
    return { status: "current", message: "Update checks are for installed builds" };
  }
  return {
    status: "error",
    message: "Could not check for updates",
    detail: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
  };
}
function installNow() {
  publish({ status: "installing", message: "Restarting to update…", percent: 100 });
  try {
    beginQuit();
    electronUpdater.autoUpdater.quitAndInstall(true, true);
    setTimeout(cancelQuit, 2e4);
  } catch (error) {
    cancelQuit();
    publish({ status: "error", message: "Could not start the installer", detail: String(error) });
  }
}
function initUpdater(window) {
  getWindow = window;
  state = { status: "idle", currentVersion: electron.app.getVersion() };
  electronUpdater.autoUpdater.autoDownload = true;
  electronUpdater.autoUpdater.autoInstallOnAppQuit = false;
  electronUpdater.autoUpdater.allowPrerelease = false;
  if (DEV_UPDATES) electronUpdater.autoUpdater.forceDevUpdateConfig = true;
  electronUpdater.autoUpdater.verifyUpdateCodeSignature = false;
  electronUpdater.autoUpdater.on("checking-for-update", () => publish({ status: "checking", message: "Checking for updates…" }));
  electronUpdater.autoUpdater.on("update-available", (info) => {
    publish({
      status: "available",
      version: info.version,
      notes: notesOf(info),
      percent: 0,
      message: `NovaPS5 v${info.version} is available`
    });
  });
  electronUpdater.autoUpdater.on("update-not-available", () => {
    const store = readStore();
    store.lastCheckAt = Date.now();
    writeStore(store);
    publish({
      status: "current",
      message: state.manual ? "You're on the latest version" : "Up to date",
      percent: void 0
    });
  });
  electronUpdater.autoUpdater.on("download-progress", (progress) => {
    publish({
      status: "downloading",
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      message: `Downloading update… ${Math.round(progress.percent)}%`
    });
  });
  electronUpdater.autoUpdater.on("update-downloaded", (info) => {
    const store = readStore();
    store.notice = {
      version: info.version,
      from: electron.app.getVersion(),
      notes: notesOf(info),
      at: Date.now()
    };
    store.lastCheckAt = Date.now();
    writeStore(store);
    publish({
      status: "ready",
      version: info.version,
      notes: notesOf(info),
      percent: 100,
      message: `NovaPS5 v${info.version} is ready to install`
    });
  });
  electronUpdater.autoUpdater.on("error", (error) => {
    const result = explain(error);
    publish({ status: result.status, message: result.message, detail: result.detail });
  });
  if (CAN_CHECK()) {
    setTimeout(() => void checkForUpdates(false), 4e3);
  }
}
async function checkForUpdates(manual) {
  if (!CAN_CHECK()) {
    return publish({
      status: "current",
      message: "Update checks are for installed builds",
      detail: "Install NovaPS5 with its installer to receive updates automatically.",
      manual,
      percent: void 0
    });
  }
  if (checking) return checking;
  publish({ status: "checking", message: "Checking for updates…", manual });
  checking = (async () => {
    try {
      const result = await electronUpdater.autoUpdater.checkForUpdates();
      if (!result && state.status === "checking") {
        publish({ status: "current", message: "Up to date" });
      }
    } catch (error) {
      const result = explain(error);
      publish({ status: result.status, message: result.message, detail: result.detail });
    } finally {
      checking = null;
    }
    if (state.status === "checking") publish({ status: "current", message: "Up to date" });
    return state;
  })();
  return checking;
}
function pendingWhatsNew() {
  const store = readStore();
  const notice = store.notice;
  if (!notice) return null;
  if (notice.version !== electron.app.getVersion()) {
    delete store.notice;
    writeStore(store);
    return null;
  }
  return { version: notice.version, from: notice.from, notes: notice.notes };
}
function dismissWhatsNew() {
  const store = readStore();
  delete store.notice;
  writeStore(store);
}
const STORE_REGIONS = [
  { code: "GB", language: "en", label: "United Kingdom" },
  { code: "IE", language: "en", label: "Ireland" },
  { code: "DE", language: "de", label: "Germany" },
  { code: "FR", language: "fr", label: "France" },
  { code: "ES", language: "es", label: "Spain" },
  { code: "IT", language: "it", label: "Italy" },
  { code: "NL", language: "nl", label: "Netherlands" },
  { code: "AT", language: "de", label: "Austria" },
  { code: "CH", language: "de", label: "Switzerland" },
  { code: "AU", language: "en", label: "Australia" },
  { code: "JP", language: "ja", label: "Japan" },
  { code: "US", language: "en", label: "United States" }
];
const DEFAULT_REGION = STORE_REGIONS[0];
const GENRE_LABELS = {
  ACTION: "Action",
  ADVENTURE: "Adventure",
  ARCADE: "Arcade",
  BRAIN_TRAINING: "Brain Training",
  CASUAL: "Casual",
  EDUCATIONAL: "Educational",
  FAMILY: "Family",
  FIGHTING: "Fighting",
  FITNESS: "Fitness",
  HORROR: "Horror",
  MUSICRHYTHM: "Music/Rhythm",
  PARTY: "Party",
  PUZZLE: "Puzzle",
  QUIZ: "Quiz",
  RACING: "Racing",
  ROLE_PLAYING_GAMES: "RPG",
  SHOOTER: "Shooter",
  SIMULATION: "Simulation",
  SIMULATOR: "Simulator",
  SPORTS: "Sports",
  STRATEGY: "Strategy",
  UNIQUE: "Unique"
};
const STORE_GENRES = [
  { key: "action", label: "Action" },
  { key: "adventure", label: "Adventure" },
  { key: "role_playing_games", label: "RPG" },
  { key: "shooter", label: "Shooter" },
  { key: "racing", label: "Racing" },
  { key: "sports", label: "Sports" },
  { key: "horror", label: "Horror" },
  { key: "puzzle", label: "Puzzle" },
  { key: "simulation", label: "Simulation" },
  { key: "strategy", label: "Strategy" },
  { key: "fighting", label: "Fighting" },
  { key: "family", label: "Family" }
];
const FEATURED_TITLES = [
  "ASTRO BOT",
  "Marvels Spider Man 2",
  "God of War Ragnarök",
  "Horizon Forbidden West",
  "Gran Turismo 7",
  "Ghost of Tsushima",
  "Hogwarts Legacy",
  "Cyberpunk 2077",
  "Baldurs Gate 3",
  "The Last of Us Part I"
];
const REQUEST_TIMEOUT_MS = 15e3;
const cache$2 = /* @__PURE__ */ new Map();
function cacheGet(key) {
  const hit = cache$2.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache$2.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttl) {
  cache$2.set(key, { at: Date.now(), ttl, value });
}
function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
async function fetchJson(url2) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url2, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-GB,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      }
    });
    if (!response.ok) throw new Error(`PlayStation Store returned ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The PlayStation Store did not respond in time.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function firstImage(images, types) {
  for (const type of types) {
    const image = images.find((candidate) => candidate?.type === type && typeof candidate?.url === "string");
    if (image) return image.url;
  }
  return null;
}
function packageSize(link) {
  let size = 0;
  const entitlements = Array.isArray(link?.default_sku?.entitlements) ? link.default_sku.entitlements : [];
  for (const entitlement of entitlements) {
    for (const pkg of Array.isArray(entitlement?.packages) ? entitlement.packages : []) {
      const platform = String(pkg?.platformName ?? "").toLowerCase();
      const bytes2 = Number(pkg?.size);
      if (platform === "ps5" && Number.isFinite(bytes2) && bytes2 > 0) size = Math.max(size, bytes2);
    }
    const bytes = Number(entitlement?.size);
    if (Number.isFinite(bytes) && bytes > 0) size = Math.max(size, bytes);
  }
  return size > 0 ? size : null;
}
function genreLabels(link) {
  const raw = link?.metadata?.genre?.values ?? link?.metadata?.game_genre?.values ?? [];
  const labels = /* @__PURE__ */ new Set();
  for (const value of raw) {
    const key = String(value).toUpperCase();
    const label = GENRE_LABELS[key] ?? key.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    if (label) labels.add(label);
  }
  return [...labels];
}
function storeLocale(region) {
  return `${region.language}-${region.code}`.toLowerCase();
}
const ALLOWED_CLASSIFICATIONS = /* @__PURE__ */ new Set([
  "FULL_GAME",
  "PREMIUM_EDITION",
  "BUNDLE",
  "GAME_BUNDLE",
  "DELUXE_EDITION",
  "ULTIMATE_EDITION",
  "STANDARD_EDITION"
]);
function parseProduct(link, region) {
  const productId = typeof link?.id === "string" ? link.id : null;
  if (!productId) return null;
  const platforms = Array.isArray(link?.playable_platform) ? link.playable_platform : [];
  if (!platforms.some((platform) => /ps5/i.test(String(platform)))) return null;
  if (link?.top_category === "add_on") return null;
  const classification = link?.metadata?.store_display_classification?.values?.[0];
  if (typeof classification === "string" && !ALLOWED_CLASSIFICATIONS.has(classification)) return null;
  const name = String(link?.name ?? link?.title_name ?? "").trim();
  if (!name) return null;
  const images = Array.isArray(link?.images) ? link.images : [];
  const coverUrl = firstImage(images, [10, 1, 12, 13]);
  if (!coverUrl) return null;
  const titleMatch = productId.match(/(PPSA\d{5}|CUSA\d{5})/);
  return {
    id: `psn:${productId}`,
    source: "psn",
    name,
    titleId: titleMatch ? titleMatch[1] : null,
    publisher: typeof link?.provider_name === "string" ? link.provider_name : null,
    genres: genreLabels(link),
    releaseDate: typeof link?.release_date === "string" ? link.release_date : null,
    coverUrl,
    heroUrl: firstImage(images, [12, 13, 14, 10]),
    sizeBytes: packageSize(link),
    downloadUrl: null,
    sha256: null,
    storeUrl: `https://store.playstation.com/${storeLocale(region)}/product/${encodeURIComponent(productId)}`
  };
}
function normalizeName(name) {
  return name.toLowerCase().replace(/[™®©]/g, "").replace(/\b(ps4|ps5)\b/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}
function dedupeGames(games) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const game of games) {
    const key = normalizeName(game.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(game);
  }
  return out;
}
function matchesGenre(game, genre) {
  if (!genre) return true;
  const label = GENRE_LABELS[genre.toUpperCase()] ?? genre;
  return game.genres.some((value) => value.toLowerCase() === label.toLowerCase());
}
function pageResult(games, total, offset, size, region, error) {
  return {
    games,
    total,
    offset,
    size,
    hasMore: offset + size < total,
    region: region.code,
    error
  };
}
async function browsePsn(query = {}, region = DEFAULT_REGION) {
  const requestedSize = clampInt(query.size, 1, 100, 40);
  const genreIndex = query.genre ? STORE_GENRES.findIndex((entry) => entry.key === query.genre) : -1;
  const size = Math.min(100, requestedSize + (genreIndex >= 0 ? genreIndex + 1 : 0));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const params = new URLSearchParams({
    size: String(size),
    start: String(offset),
    game_content_type: "games",
    platform: "ps5",
    sort: "release_date",
    direction: "desc"
  });
  if (query.genre) {
    params.set("genre", query.genre);
  } else {
    params.set("release_date", "last_30_days");
  }
  const fetchFor = (target) => fetchJson(
    `https://store.playstation.com/store/api/chihiro/00_09_000/container/${target.code}/${target.language}/999/STORE-MSF75508-FULLGAMES?${params.toString()}`
  );
  let used = region;
  let json;
  try {
    json = await fetchFor(region);
  } catch (error) {
    if (region.code === DEFAULT_REGION.code) throw error;
    used = DEFAULT_REGION;
    json = await fetchFor(used);
  }
  const links = Array.isArray(json?.links) ? json.links : [];
  const games = dedupeGames(
    links.map((link) => parseProduct(link, used)).filter((game) => game !== null).filter((game) => matchesGenre(game, query.genre))
  );
  const total = Math.max(Number(json?.total_results) || 0, offset + games.length);
  return pageResult(
    games,
    total,
    offset,
    size,
    used,
    used.code !== region.code ? `The ${region.label} catalog is unavailable — showing ${used.label}.` : void 0
  );
}
async function searchPsn(query = {}, region = DEFAULT_REGION) {
  const rawText = (query.text ?? "").trim();
  const text = rawText.replace(/['’™®©]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return browsePsn(query, region);
  const size = clampInt(query.size, 1, 40, 30);
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const wanted = Math.min(size, 12);
  const collected = [];
  let cursor = offset;
  let total = 0;
  for (let page = 0; page < 4; page += 1) {
    const url2 = `https://store.playstation.com/store/api/chihiro/00_09_000/tumbler/${region.code}/${region.language}/999/${encodeURIComponent(text)}?size=${size}&mode=game&start=${cursor}`;
    const json = await fetchJson(url2);
    total = Math.max(total, Number(json?.total_results) || 0);
    const links = Array.isArray(json?.links) ? json.links : [];
    collected.push(
      ...links.map((link) => parseProduct(link, region)).filter((game) => game !== null).filter((game) => matchesGenre(game, query.genre))
    );
    cursor += size;
    if (collected.length >= wanted || cursor >= total || links.length === 0) break;
  }
  const games = dedupeGames(collected);
  const consumed = Math.max(size, cursor - offset);
  return pageResult(games, Math.max(total, offset + games.length), offset, consumed, region);
}
async function featuredPsn(region = DEFAULT_REGION) {
  const key = `featured:${region.code}`;
  const cached2 = cacheGet(key);
  if (cached2) return cached2;
  const results = await Promise.allSettled(
    FEATURED_TITLES.map((title) => searchPsn({ text: title, size: 5 }, region))
  );
  const games = [];
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status !== "fulfilled") continue;
    const wanted = normalizeName(FEATURED_TITLES[index]);
    const match = result.value.games.find((game) => !seen.has(game.id) && normalizeName(game.name) === wanted) ?? result.value.games.find((game) => !seen.has(game.id));
    if (match) {
      seen.add(match.id);
      games.push(match);
    }
  }
  if (games.length > 0) cacheSet(key, games, 15 * 6e4);
  return games;
}
const CATALOG_TTL_MS = 2 * 6e4;
const MAX_EMBEDDED_COVER_BYTES = 4 * 1024 * 1024;
const cache$1 = /* @__PURE__ */ new Map();
function slug$1(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "game";
}
function isHttp$1(value) {
  return /^https?:\/\//i.test(value);
}
function resolveTarget(value, base) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isHttp$1(trimmed) || trimmed.startsWith("file://")) return trimmed;
  if (!base) return trimmed;
  if (isHttp$1(base)) {
    try {
      return new URL(trimmed, base).toString();
    } catch {
      return null;
    }
  }
  return path.resolve(base, trimmed);
}
async function resolveCover(value, base) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (/^(https?:|data:)/i.test(raw)) return raw;
  if (!base) return null;
  if (isHttp$1(base)) {
    try {
      return new URL(raw, base).toString();
    } catch {
      return null;
    }
  }
  try {
    const file = raw.startsWith("file://") ? url.fileURLToPath(raw) : path.resolve(base, raw);
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_EMBEDDED_COVER_BYTES) return null;
    const data = await fs.promises.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}
async function toStoreGame(raw, base, index) {
  const name = String(raw?.name ?? raw?.title ?? "").trim();
  if (!name) return null;
  const id = String(raw?.id ?? `${slug$1(name)}-${index}`).trim() || `${slug$1(name)}-${index}`;
  const downloadUrl = resolveTarget(
    String(raw?.downloadUrl ?? raw?.download ?? raw?.url ?? "").trim(),
    base
  );
  return {
    id: `catalog:${id}`,
    source: "catalog",
    name,
    titleId: typeof raw?.titleId === "string" ? raw.titleId : null,
    publisher: typeof raw?.publisher === "string" ? raw.publisher : null,
    genres: Array.isArray(raw?.genres) ? raw.genres.map(String) : [],
    releaseDate: typeof raw?.releaseDate === "string" ? raw.releaseDate : null,
    coverUrl: await resolveCover(raw?.coverUrl ?? raw?.cover, base) ?? null,
    heroUrl: await resolveCover(raw?.heroUrl ?? raw?.hero, base) ?? null,
    sizeBytes: Number.isFinite(Number(raw?.sizeBytes)) ? Number(raw.sizeBytes) : null,
    downloadUrl,
    sha256: typeof raw?.sha256 === "string" ? raw.sha256 : null,
    storeUrl: typeof raw?.storeUrl === "string" ? raw.storeUrl : null
  };
}
async function readCatalog(source) {
  if (isHttp$1(source)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15e3);
    try {
      const response = await fetch(source, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        }
      });
      if (!response.ok) throw new Error(`Catalog returned ${response.status}`);
      return { text: await response.text(), base: source };
    } finally {
      clearTimeout(timer);
    }
  }
  const file = source.startsWith("file://") ? url.fileURLToPath(source) : path.resolve(source);
  const text = await fs.promises.readFile(file, "utf8");
  return { text: text.charCodeAt(0) === 65279 ? text.slice(1) : text, base: path.dirname(file) };
}
async function loadCatalog(settings) {
  const source = settings.catalogUrl?.trim();
  if (!source) return [];
  const cached2 = cache$1.get(source);
  if (cached2 && Date.now() - cached2.at < CATALOG_TTL_MS) return cached2.value;
  const { text, base } = await readCatalog(source);
  const parsed = JSON.parse(text);
  const rawGames = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.games) ? parsed.games : [];
  const games = (await Promise.all(rawGames.map((raw, index) => toStoreGame(raw, base, index)))).filter((game) => game !== null);
  cache$1.set(source, { at: Date.now(), value: games });
  return games;
}
function invalidateCatalog() {
  cache$1.clear();
}
const DEFAULT_STORE_SETTINGS = {
  region: "GB",
  language: "en",
  catalogUrl: null
};
function storeFile() {
  return path.join(libraryRoot(), "store.json");
}
let cache = null;
let loading = null;
let persistQueue = Promise.resolve();
function sanitizeSettings(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    region: typeof raw.region === "string" && raw.region.trim() ? raw.region.trim().toUpperCase() : DEFAULT_STORE_SETTINGS.region,
    language: typeof raw.language === "string" && raw.language.trim() ? raw.language.trim().toLowerCase() : DEFAULT_STORE_SETTINGS.language,
    catalogUrl: typeof raw.catalogUrl === "string" && raw.catalogUrl.trim() ? raw.catalogUrl.trim() : null
  };
}
function sanitizeEntry(value) {
  const raw = value;
  if (!raw) return null;
  const game = raw.game;
  if (!game || typeof game.id !== "string" || typeof game.name !== "string") return null;
  return {
    game: {
      id: game.id,
      source: game.source === "catalog" ? "catalog" : "psn",
      name: game.name,
      titleId: typeof game.titleId === "string" ? game.titleId : null,
      publisher: typeof game.publisher === "string" ? game.publisher : null,
      genres: Array.isArray(game.genres) ? game.genres.map(String) : [],
      releaseDate: typeof game.releaseDate === "string" ? game.releaseDate : null,
      coverUrl: typeof game.coverUrl === "string" ? game.coverUrl : null,
      heroUrl: typeof game.heroUrl === "string" ? game.heroUrl : null,
      sizeBytes: Number.isFinite(Number(game.sizeBytes)) ? Number(game.sizeBytes) : null,
      downloadUrl: typeof game.downloadUrl === "string" ? game.downloadUrl : null,
      sha256: typeof game.sha256 === "string" ? game.sha256 : null,
      storeUrl: typeof game.storeUrl === "string" ? game.storeUrl : null
    },
    addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : Date.now(),
    status: raw.status === "downloading" || raw.status === "downloaded" || raw.status === "installed" ? raw.status : "wishlist",
    localPath: typeof raw.localPath === "string" ? raw.localPath : void 0,
    installedGameId: typeof raw.installedGameId === "string" ? raw.installedGameId : void 0
  };
}
async function readStoreFile(file) {
  const raw = await fs.promises.readFile(file, "utf8");
  const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
  const parsed = JSON.parse(text);
  return {
    settings: sanitizeSettings(parsed?.settings),
    entries: Array.isArray(parsed?.entries) ? parsed.entries.map(sanitizeEntry).filter(Boolean) : []
  };
}
async function load() {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    const empty = { settings: { ...DEFAULT_STORE_SETTINGS }, entries: [] };
    let loaded;
    try {
      loaded = await readStoreFile(storeFile());
    } catch {
      try {
        loaded = await readStoreFile(`${storeFile()}.bak`);
      } catch {
        loaded = empty;
      }
    }
    cache = loaded;
    return loaded;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}
function persist() {
  const task = persistQueue.then(async () => {
    if (!cache) return;
    const file = storeFile();
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await fs.promises.copyFile(file, `${file}.bak`).catch(() => {
    });
    await fs.promises.rename(tmp, file);
  });
  persistQueue = task.catch(() => {
  });
  return task;
}
async function getStoreSettings() {
  return { ...(await load()).settings };
}
async function updateStoreSettings(patch) {
  const data = await load();
  data.settings = sanitizeSettings({ ...data.settings, ...patch });
  await persist();
  return { ...data.settings };
}
async function listStoreEntries() {
  const data = await load();
  return [...data.entries].sort((a, b) => b.addedAt - a.addedAt);
}
async function getStoreEntry(id) {
  return (await load()).entries.find((entry) => entry.game.id === id);
}
async function addStoreEntry(game) {
  const data = await load();
  const existing = data.entries.find((entry) => entry.game.id === game.id);
  if (existing) {
    existing.game = {
      ...game,
      downloadUrl: game.downloadUrl ?? existing.game.downloadUrl,
      sha256: game.sha256 ?? existing.game.sha256
    };
  } else {
    data.entries.push({ game: { ...game }, addedAt: Date.now(), status: "wishlist" });
  }
  await persist();
  return listStoreEntries();
}
async function removeStoreEntry(id) {
  const data = await load();
  data.entries = data.entries.filter((entry) => entry.game.id !== id);
  await persist();
  return listStoreEntries();
}
async function setStoreDownloadUrl(id, url2) {
  const data = await load();
  const entry = data.entries.find((candidate) => candidate.game.id === id);
  if (!entry) throw new Error("Add this game to your library before giving it a download URL.");
  entry.game.downloadUrl = url2?.trim() ? url2.trim() : null;
  await persist();
  return listStoreEntries();
}
async function updateStoreEntry(id, patch) {
  const data = await load();
  const entry = data.entries.find((candidate) => candidate.game.id === id);
  if (!entry) return;
  if (patch.status) entry.status = patch.status;
  if (patch.localPath !== void 0) entry.localPath = patch.localPath;
  if (patch.installedGameId !== void 0) entry.installedGameId = patch.installedGameId;
  await persist();
}
const active = /* @__PURE__ */ new Map();
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
function isHttp(value) {
  return /^https?:\/\//i.test(value);
}
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "game";
}
function fileNameFromUrl(url2, name) {
  try {
    const parsed = new URL(url2);
    const base = path.basename(decodeURIComponent(parsed.pathname.split("/").pop() ?? ""));
    const match = base.match(/\.(zip|rar|7z)$/i);
    if (match) {
      const ext = match[1].toLowerCase();
      return `${slug(base.slice(0, -match[0].length))}.${ext}`;
    }
    return `${slug(base.replace(/\.[^.]+$/, "") || name)}.zip`;
  } catch {
    return `${slug(name)}.zip`;
  }
}
function makeReport(jobId, game, emit) {
  return (step, message, percent, extra = {}) => {
    emit({
      jobId,
      gameId: game.id,
      gameName: game.name,
      step,
      message,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      status: "running",
      ...extra
    });
  };
}
async function installFromPath(game, sourcePath, jobId, emit, basePercent) {
  const span = 100 - basePercent;
  const installed = await installGame(
    sourcePath,
    game.name,
    (progress) => {
      if (progress.status !== "running") return;
      emit({
        jobId,
        gameId: game.id,
        gameName: game.name,
        step: "installing",
        message: progress.message,
        percent: Math.max(0, Math.min(100, Math.round(basePercent + progress.percent / 100 * span))),
        status: "running"
      });
    },
    jobId
  );
  await updateStoreEntry(game.id, { status: "installed", installedGameId: installed.id }).catch(
    () => {
    }
  );
  emit({
    jobId,
    gameId: game.id,
    gameName: game.name,
    step: "done",
    message: `${game.name} installed`,
    percent: 100,
    status: "done",
    installedGameId: installed.id
  });
}
async function startStoreDownload(game, url$1, jobId, emit) {
  const report = makeReport(jobId, game, emit);
  const target = url$1.trim();
  let destDir = null;
  let connectTimedOut = false;
  try {
    await updateStoreEntry(game.id, { status: "downloading" });
    if (!isHttp(target)) {
      report("queued", `Opening ${game.name}…`, 1);
      const local = target.startsWith("file://") ? url.fileURLToPath(target) : target;
      if (!fs.existsSync(local)) throw new Error(`The catalog points at "${target}", which does not exist.`);
      await installFromPath(game, local, jobId, emit, 0);
      return;
    }
    destDir = path.join(downloadsRoot(), `${slug(game.name)}-${Date.now()}`);
    ensureDir(destDir);
    const dest = path.join(destDir, fileNameFromUrl(target, game.name));
    const controller = new AbortController();
    active.set(jobId, controller);
    report("queued", `Connecting to the download server…`, 0);
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      controller.abort();
    }, 45e3);
    let response;
    try {
      response = await fetch(target, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" }
      });
    } finally {
      clearTimeout(connectTimer);
    }
    if (!response.ok || !response.body) {
      throw new Error(`Download failed — the server returned ${response.status}.`);
    }
    const total = Number(response.headers.get("content-length")) || game.sizeBytes || 0;
    const handle = await fs.promises.open(dest, "w");
    const hash = game.sha256 ? crypto.createHash("sha256") : null;
    const reader = response.body.getReader();
    let received = 0;
    let lastEmit = 0;
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        await handle.write(value);
        received += value.length;
        hash?.update(value);
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          const percent = total > 0 ? Math.min(88, received / total * 88) : Math.min(88, 5 + received / (1024 * 1024));
          report("downloading", `Downloading ${game.name}…`, percent, {
            receivedBytes: received,
            totalBytes: total || void 0
          });
        }
      }
    } finally {
      await handle.close();
      active.delete(jobId);
    }
    report("downloading", `Downloaded ${game.name}`, 90, {
      receivedBytes: received,
      totalBytes: total || void 0
    });
    if (hash && game.sha256) {
      report("verifying", "Verifying the download…", 91);
      const digest = hash.digest("hex").toLowerCase();
      if (digest !== game.sha256.trim().toLowerCase()) {
        throw new Error("The download did not match its SHA-256 checksum — it may be corrupted.");
      }
    }
    if (!/\.(zip|rar|7z)$/i.test(dest)) {
      throw new Error("The downloaded file is not an archive (.zip/.rar/.7z). Point the catalog at a game archive.");
    }
    await installFromPath(game, dest, jobId, emit, 91);
    await fs.promises.rm(destDir, { recursive: true, force: true }).catch(() => {
    });
    destDir = null;
  } catch (error) {
    active.delete(jobId);
    const aborted = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
    const message = connectTimedOut ? "The download server did not respond." : aborted ? "Download cancelled." : error instanceof Error ? error.message : String(error);
    await updateStoreEntry(game.id, { status: "wishlist" }).catch(() => {
    });
    emit({
      jobId,
      gameId: game.id,
      gameName: game.name,
      step: "error",
      message: "Download failed",
      percent: 0,
      status: "error",
      error: message
    });
    if (destDir) await fs.promises.rm(destDir, { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
}
async function startStoreLocalInstall(game, sourcePath, jobId, emit) {
  const report = makeReport(jobId, game, emit);
  try {
    await updateStoreEntry(game.id, { status: "downloading" });
    report("queued", `Preparing ${game.name}…`, 1);
    await installFromPath(game, sourcePath, jobId, emit, 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateStoreEntry(game.id, { status: "wishlist" }).catch(() => {
    });
    emit({
      jobId,
      gameId: game.id,
      gameName: game.name,
      step: "error",
      message: "Install failed",
      percent: 0,
      status: "error",
      error: message
    });
    throw error;
  }
}
function cancelStoreDownload(jobId) {
  const controller = active.get(jobId);
  if (!controller) return;
  controller.abort();
  active.delete(jobId);
}
async function appInfo() {
  const { relinker, libs } = toolingPresent();
  return {
    toolsDir: toolsDir(),
    appVersion: electron.app.getVersion(),
    relinkerPresent: relinker,
    libsPresent: libs,
    pythonPath: await findPython(),
    pythonBundled: (await pythonInvocation())?.bundled ?? false,
    libraryRoot: libraryRoot(),
    gamesDir: gamesRoot(),
    runtimeVersion: readRuntimeManifest()?.version ?? null,
    runtimeRepo: runtimeRepo(),
    appRepo: APP_REPO
  };
}
function regionFor(settings) {
  return STORE_REGIONS.find((r) => r.code === settings.region && r.language === settings.language) ?? STORE_REGIONS.find((r) => r.code === settings.region) ?? STORE_REGIONS[0];
}
function normalizedName(name) {
  return name.toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function searchableName(value) {
  return value.toLowerCase().replace(/['’™®©]/g, "").replace(/\s+/g, " ").trim();
}
function mergeCatalog(catalog, games) {
  const ids = new Set(catalog.map((game) => game.id));
  const names = new Set(catalog.map((game) => normalizedName(game.name)));
  return [
    ...catalog,
    ...games.filter((game) => !ids.has(game.id) && !names.has(normalizedName(game.name)))
  ];
}
function catalogMatchesGenre(game, genre) {
  if (!genre) return true;
  const label = STORE_GENRES.find((entry) => entry.key === genre)?.label.toLowerCase() ?? genre.toLowerCase();
  return game.genres.some((value) => value.toLowerCase() === label);
}
async function storeQuery(query = {}) {
  const settings = await getStoreSettings();
  const region = regionFor(settings);
  let catalog = [];
  let catalogError;
  try {
    catalog = (await loadCatalog(settings)).filter((game) => catalogMatchesGenre(game, query.genre));
  } catch (error) {
    catalogError = `Games catalog: ${error instanceof Error ? error.message : String(error)}`;
  }
  const size = Math.min(100, Math.max(1, Math.floor(query.size ?? 40)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const text = query.text?.trim();
  try {
    const result = text ? await searchPsn(query, region) : await browsePsn(query, region);
    if (text) {
      const needle = searchableName(text);
      const matches = catalog.filter(
        (game) => searchableName(game.name).includes(needle) || searchableName(game.publisher ?? "").includes(needle)
      );
      return {
        ...result,
        games: mergeCatalog(matches, result.games),
        total: result.total + matches.length,
        error: catalogError ?? result.error
      };
    }
    return {
      ...result,
      games: offset > 0 ? result.games : mergeCatalog(catalog, result.games),
      total: result.total + catalog.length,
      error: catalogError ?? result.error
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (catalog.length > 0) {
      return {
        games: catalog,
        total: catalog.length,
        offset: 0,
        size,
        hasMore: false,
        region: region.code,
        error: catalogError ?? `PlayStation Store unavailable: ${message}`
      };
    }
    throw error;
  }
}
function registerIpc(getWindow2) {
  electron.ipcMain.handle("app:info", () => appInfo());
  electron.ipcMain.handle("app:displays", () => {
    const primaryId = electron.screen.getPrimaryDisplay().id;
    return electron.screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label: display.label || `Display ${index + 1}`,
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      refreshRate: display.displayFrequency,
      scaleFactor: display.scaleFactor,
      primary: display.id === primaryId
    }));
  });
  electron.ipcMain.handle("dialog:selectFolder", async () => {
    const win = getWindow2();
    const options = { properties: ["openDirectory", "createDirectory"] };
    const result = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });
  electron.ipcMain.handle("dialog:selectZip", async () => {
    const win = getWindow2();
    const options = {
      properties: ["openFile"],
      filters: [
        {
          name: "PS5 dump archive",
          extensions: ["zip", "rar", "7z", "tar", "tgz", "tar.gz", "tar.xz", "gz", "xz"]
        }
      ]
    };
    const result = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });
  electron.ipcMain.handle("library:detect", (_e, sourcePath) => detectDump(sourcePath));
  electron.ipcMain.handle("library:list", () => listGames());
  electron.ipcMain.handle("library:scan", () => scanLibrary());
  electron.ipcMain.handle("game:launch", (_e, id) => launchGame(id));
  electron.ipcMain.handle("game:remove", async (_e, id) => {
    await removeGame(id);
    return { ok: true };
  });
  electron.ipcMain.handle(
    "game:setGraphics",
    (_e, id, patch) => setGameGraphics(id, patch)
  );
  electron.ipcMain.handle(
    "game:setCompatibility",
    (_e, id, patch) => setGameCompatibility(id, patch)
  );
  electron.ipcMain.handle("game:trophyPackage", async (_e, id) => {
    const game = await getGame(id);
    if (!game) throw new Error("Game not found in library.");
    return readTrophyPackages(game.installPath);
  });
  electron.ipcMain.handle("game:clearShaderCache", (_e, id) => clearShaderCache(id));
  electron.ipcMain.handle("game:session", (_e, id) => readSession(id));
  electron.ipcMain.handle("game:performance", async (_e, id) => {
    const game = await getGame(id);
    if (!game) throw new Error("Game not found in library.");
    return readPerformanceProfile(game);
  });
  electron.ipcMain.handle("install:start", (_e, req) => {
    const jobId = crypto.randomUUID();
    installGame(req.sourcePath, req.name, (progress) => {
      getWindow2()?.webContents.send("install:progress", progress);
    }, jobId).catch(() => {
    });
    return { jobId };
  });
  electron.ipcMain.handle("bootstrap:run", () => {
    const win = getWindow2();
    return ensureRuntime((step) => win?.webContents.send("bootstrap:step", step));
  });
  electron.ipcMain.handle("settings:get", () => ({
    gamesDir: gamesRoot(),
    runtimeRepo: runtimeRepo()
  }));
  electron.ipcMain.handle("settings:setGamesDir", (_e, dir) => setGamesDir(dir));
  electron.ipcMain.handle("update:state", () => updateState());
  electron.ipcMain.handle("update:check", () => checkForUpdates(true));
  electron.ipcMain.handle("update:install", () => {
    installNow();
    return { ok: true };
  });
  electron.ipcMain.handle("update:whatsNew", () => pendingWhatsNew());
  electron.ipcMain.handle("update:dismissWhatsNew", () => {
    dismissWhatsNew();
    return { ok: true };
  });
  electron.ipcMain.handle("app:openExternal", async (_e, url2) => {
    if (/^https?:\/\//i.test(url2)) await electron.shell.openExternal(url2);
  });
  electron.ipcMain.handle("app:openDisplaySettings", async () => {
    if (process.platform === "win32") await electron.shell.openExternal("ms-settings:display");
  });
  electron.ipcMain.handle("store:regions", () => STORE_REGIONS);
  electron.ipcMain.handle("store:settings:get", () => getStoreSettings());
  electron.ipcMain.handle("store:settings:set", async (_e, patch) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, "catalogUrl")) invalidateCatalog();
    return updateStoreSettings(patch);
  });
  electron.ipcMain.handle("store:browse", (_e, query) => storeQuery(query ?? {}));
  electron.ipcMain.handle("store:search", (_e, query) => storeQuery(query ?? {}));
  electron.ipcMain.handle("store:featured", async () => {
    const settings = await getStoreSettings();
    const region = regionFor(settings);
    let catalog = [];
    try {
      catalog = await loadCatalog(settings);
    } catch {
    }
    const featured = await featuredPsn(region).catch(() => []);
    return mergeCatalog(catalog.slice(0, 6), featured).slice(0, 10);
  });
  electron.ipcMain.handle("store:library:list", () => listStoreEntries());
  electron.ipcMain.handle("store:add", (_e, game) => addStoreEntry(game));
  electron.ipcMain.handle("store:remove", (_e, id) => removeStoreEntry(id));
  electron.ipcMain.handle(
    "store:setDownload",
    (_e, id, url2) => setStoreDownloadUrl(id, url2)
  );
  electron.ipcMain.handle("store:download", async (_e, id, url2) => {
    const entry = await getStoreEntry(id);
    if (!entry) throw new Error("Add this game to your library first.");
    const candidate = url2?.trim() ?? "";
    if (candidate) await setStoreDownloadUrl(id, candidate);
    const target = (candidate || entry.game.downloadUrl || "").trim();
    if (!target) {
      throw new Error("This game has no download URL. Attach one you host, or install from a file.");
    }
    const jobId = crypto.randomUUID();
    const send = (progress) => {
      getWindow2()?.webContents.send("store:progress", progress);
    };
    startStoreDownload(entry.game, target, jobId, send).catch(() => {
    });
    return { jobId };
  });
  electron.ipcMain.handle("store:installLocal", async (_e, id, sourcePath) => {
    const entry = await getStoreEntry(id);
    if (!entry) throw new Error("Add this game to your library first.");
    const jobId = crypto.randomUUID();
    const send = (progress) => {
      getWindow2()?.webContents.send("store:progress", progress);
    };
    startStoreLocalInstall(entry.game, sourcePath, jobId, send).catch(() => {
    });
    return { jobId };
  });
  electron.ipcMain.handle("store:cancel", (_e, jobId) => {
    cancelStoreDownload(jobId);
    return { ok: true };
  });
}
electron.protocol.registerSchemesAsPrivileged([
  { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
let mainWindow = null;
let tray = null;
let trayHintShown = false;
function iconPath() {
  return electron.app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(electron.app.getAppPath(), "public", "icon.png");
}
const iconFile = () => electron.app.isPackaged ? path.join(process.resourcesPath, "icon.ico") : path.join(electron.app.getAppPath(), "build", "icon.ico");
function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}
function hideToTray() {
  mainWindow?.hide();
  if (trayHintShown || !tray) return;
  trayHintShown = true;
  try {
    tray.displayBalloon({
      title: "NovaPS5 is still running",
      content: "Click the tray icon to bring the window back — Quit in its menu closes the app."
    });
  } catch {
  }
}
function askInstall() {
  showWindow();
  mainWindow?.webContents.send("ui:install");
}
function createWindow() {
  const { workAreaSize } = electron.screen.getPrimaryDisplay();
  const width = Math.min(1280, Math.max(980, workAreaSize.width - 48));
  const height = Math.min(820, Math.max(620, workAreaSize.height - 48));
  mainWindow = new electron.BrowserWindow({
    width,
    height,
    minWidth: Math.min(980, width),
    minHeight: Math.min(620, height),
    center: true,
    show: false,
    backgroundColor: "#09090b",
    icon: fs.existsSync(iconFile()) ? iconFile() : iconPath(),
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
  mainWindow.on("close", (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    hideToTray();
  });
  attachContextMenu(mainWindow);
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
function attachContextMenu(window) {
  window.webContents.on("context-menu", (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0;
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: "cut", label: "Cut", enabled: hasSelection },
        { role: "copy", label: "Copy", enabled: hasSelection },
        { role: "paste", label: "Paste" },
        { type: "separator" },
        { role: "selectAll", label: "Select all" }
      );
    } else if (hasSelection) {
      items.push({ role: "copy", label: "Copy" }, { type: "separator" }, { role: "selectAll", label: "Select all" });
    }
    if (items.length) electron.Menu.buildFromTemplate(items).popup({ window });
  });
}
function createTray() {
  try {
    const source = fs.existsSync(iconFile()) ? iconFile() : iconPath();
    const image = electron.nativeImage.createFromPath(source);
    tray = new electron.Tray(image.isEmpty() ? electron.nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
    tray.setToolTip("NovaPS5");
    tray.setContextMenu(
      electron.Menu.buildFromTemplate([
        { label: "Open NovaPS5", click: showWindow },
        { label: "Install a game…", click: askInstall },
        { label: "Check for updates…", click: () => void checkForUpdates(true) },
        { type: "separator" },
        {
          label: "Quit NovaPS5",
          click: () => {
            beginQuit();
            electron.app.quit();
          }
        }
      ])
    );
    tray.on("double-click", showWindow);
    tray.on("click", showWindow);
  } catch {
    tray = null;
  }
}
function buildMenu() {
  electron.Menu.setApplicationMenu(
    electron.Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "Install a game…", accelerator: "CmdOrCtrl+O", click: askInstall },
          { label: "Check for updates…", click: () => void checkForUpdates(true) },
          { type: "separator" },
          {
            label: "Quit NovaPS5",
            accelerator: "CmdOrCtrl+Q",
            click: () => {
              beginQuit();
              electron.app.quit();
            }
          }
        ]
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" }
        ]
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" }
        ]
      }
    ])
  );
}
function registerMediaProtocol() {
  electron.protocol.handle("media", async (request) => {
    try {
      const url2 = new URL(request.url);
      const rel = decodeURIComponent(url2.pathname).replace(/^\/+/, "");
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
}
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => showWindow());
  electron.app.setAppUserModelId("com.novaps5.app");
  electron.app.whenReady().then(() => {
    registerMediaProtocol();
    ensureDir(gamesRoot());
    registerIpc(() => mainWindow);
    buildMenu();
    createWindow();
    createTray();
    initUpdater(() => mainWindow);
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });
}
electron.app.on("before-quit", () => {
  beginQuit();
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
