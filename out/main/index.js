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
let cache = null;
async function load() {
  if (cache) return cache;
  cache = { games: [] };
  try {
    const raw = await fs.promises.readFile(libraryFile(), "utf8");
    const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
    const parsed = JSON.parse(text);
    cache = { games: Array.isArray(parsed.games) ? parsed.games : [] };
  } catch {
    try {
      const backup = await fs.promises.readFile(`${libraryFile()}.bak`, "utf8");
      const text = backup.charCodeAt(0) === 65279 ? backup.slice(1) : backup;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.games)) cache = { games: parsed.games };
    } catch {
    }
  }
  return cache;
}
async function persist() {
  if (!cache) return;
  ensureDir(path.dirname(libraryFile()));
  const file = libraryFile();
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await fs.promises.copyFile(file, `${file}.bak`).catch(() => {
  });
  await fs.promises.rename(tmp, file);
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
  cache = null;
  const data = await load();
  const summary = { added: 0, missing: 0, repaired: 0 };
  for (const game of data.games) {
    const exeOk = await exists(game.exePath);
    const dirOk = await exists(game.installPath);
    if (exeOk) {
      if (game.status !== "ready" || game.error) {
        game.status = "ready";
        delete game.error;
        summary.repaired++;
      }
    } else {
      const detail = dirOk ? "The game executable is missing — reinstall the game." : "The install folder is gone.";
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
  if (summary.added > 0 || summary.missing > 0 || summary.repaired > 0) await persist();
  const games = [...data.games].sort((a, b) => b.installedAt - a.installedAt);
  return { games, summary };
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
const SELF_KERNEL_MAGIC = Buffer.from([84, 20, 245, 238]);
const ELF_MAGIC$1 = Buffer.from([127, 69, 76, 70]);
const PE_MAGIC = Buffer.from([77, 90]);
function detectContainer(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 0);
    if (read < 2) return "unknown";
    if (buf.subarray(0, 4).equals(ELF_MAGIC$1)) return "elf";
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
  const args = [...python.args, unwrapScriptPath(), input, output];
  if (verbose) args.push("--verbose");
  const { code, stdout, stderr } = await run(python.cmd, args, { timeoutMs: 10 * 60 * 1e3 });
  if (code !== 0) {
    const detail = /not a SELF container/i.test(stderr) ? `${path.basename(input)} is not a SELF container.` : /looks encrypted/i.test(stderr) ? `${path.basename(input)} is still encrypted — dump it decrypted before converting.` : stderr.trim() || stdout.trim() || `exit code ${code}`;
    throw new Error(`Unwrap failed — ${detail}`);
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
      (m) => `Several modules identify as "${m[1]}" — remove the duplicate copies from the dump.`
    ],
    [
      /^Both sce_module and sce_modules exist/i,
      () => "The dump has both sce_module/ and sce_modules/ — keep only one of them."
    ],
    [
      /^Guest module parent directory does not exist/i,
      () => "No sce_module/ folder was found — this dump ships no loadable modules for the converter."
    ],
    [
      /^Excluded guest module file not found/i,
      () => "The dump layout changed mid-conversion — retry the installation."
    ]
  ];
  for (const [pattern, describe] of rules) {
    const match = detail.match(pattern);
    if (match) return describe(match);
  }
  return detail;
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
    throw new Error(`Conversion failed — ${explainRelinkFailure(detail)}`);
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
    try {
      const followed = await fs.promises.stat(from);
      if (followed.isDirectory()) {
        await copyDir(from, to, onBytes, depth + 1);
      } else {
        await fs.promises.copyFile(from, to);
        onBytes(followed.size);
      }
    } catch {
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
const ELF_MAGIC = Buffer.from([127, 69, 76, 70]);
const SELF_MAGICS = [
  Buffer.from([79, 21, 61, 29]),
  Buffer.from([84, 20, 245, 238])
];
function isBackupName(name) {
  return /\.(bak|backup|old|orig)([._-].*)?$/i.test(name) || name.endsWith("~");
}
async function fileMagic(file) {
  let handle = null;
  try {
    handle = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    if (bytesRead < 4) return "other";
    if (buf.equals(ELF_MAGIC)) return "elf";
    if (SELF_MAGICS.some((magic) => buf.equals(magic))) return "self";
    return "other";
  } catch {
    return "other";
  } finally {
    if (handle) await handle.close().catch(() => {
    });
  }
}
function moduleDirRank(rel) {
  if (rel === "sce_module") return 0;
  if (rel === "sce_modules") return 1;
  if (rel === "prx") return 2;
  return 3;
}
function normalizeLibName(name) {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.toLowerCase().replace(/\.(prx|sprx|so|elf)$/, "");
}
function readNeeded(elfPath) {
  let fd = null;
  try {
    fd = fs.openSync(elfPath, "r");
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, 64, 0) < 52) return null;
    if (!head.subarray(0, 4).equals(ELF_MAGIC)) return null;
    const is64 = head[4] === 2;
    const phoff = Number(is64 ? head.readBigUInt64LE(32) : head.readUInt32LE(28));
    const phentsize = head.readUInt16LE(is64 ? 54 : 42);
    const phnum = head.readUInt16LE(is64 ? 56 : 44);
    if (phnum === 0 || phnum > 256) return null;
    const loads = [];
    let dynOff = -1;
    let dynSize = 0;
    const phdr = Buffer.alloc(phentsize);
    for (let i = 0; i < phnum; i++) {
      fs.readSync(fd, phdr, 0, phentsize, phoff + i * phentsize);
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
    if (dynOff < 0 || dynSize <= 0) return null;
    const vaddrToOff = (vaddr) => {
      for (const load2 of loads) {
        if (vaddr >= load2.vaddr && vaddr < load2.vaddr + load2.filesz) {
          return load2.off + (vaddr - load2.vaddr);
        }
      }
      return -1;
    };
    const entrySize = is64 ? 16 : 8;
    const dyn = Buffer.alloc(Math.min(dynSize, entrySize * 1024));
    fs.readSync(fd, dyn, 0, dyn.length, dynOff);
    const tags = [];
    for (let o = 0; o + entrySize <= dyn.length; o += entrySize) {
      const tag = is64 ? Number(dyn.readBigInt64LE(o)) : dyn.readInt32LE(o);
      if (tag === 0) break;
      const val = is64 ? Number(dyn.readBigUInt64LE(o + 8)) : dyn.readUInt32LE(o + 4);
      tags.push({ tag, val });
    }
    const strtabVal = tags.find((t) => t.tag === 5)?.val;
    const neededVals = tags.filter((t) => t.tag === 1);
    if (strtabVal === void 0) return neededVals.length > 0 ? null : [];
    const strOff = vaddrToOff(strtabVal);
    if (strOff < 0) return null;
    const strsz = tags.find((t) => t.tag === 10)?.val ?? 65536;
    const strtab = Buffer.alloc(Math.min(strsz, 4 << 20));
    fs.readSync(fd, strtab, 0, strtab.length, strOff);
    const names = [];
    for (const { val } of neededVals) {
      if (val < 0 || val >= strtab.length) continue;
      const end = strtab.indexOf(0, val);
      const name = strtab.subarray(val, end === -1 ? void 0 : end).toString("latin1");
      if (name) names.push(name);
    }
    return names;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
async function walkModuleDirs(root) {
  const dirs = [];
  const visit = async (full, rel, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.promises.readdir(full, { withFileTypes: true });
    } catch {
      return;
    }
    let hasPrx = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "sce_sys") continue;
        await visit(path.join(full, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
      } else if (entry.name.endsWith(".prx") && !entry.name.endsWith(".guest.prx")) {
        hasPrx = true;
      }
    }
    if (hasPrx && rel) dirs.push(rel);
  };
  await visit(root, "", 0);
  return dirs;
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
  } else {
    const bytes = readMagicHex(eboot);
    checks.push({
      id: "eboot",
      label: "Executable",
      status: "fail",
      detail: bytes === "empty" || bytes === "unreadable" ? `eboot.bin is ${bytes} — the dump is incomplete; re-copy or re-extract it.` : `eboot.bin is not a recognized ELF or SELF file (first bytes: ${bytes}) — the file is truncated, corrupted, or not an eboot.`
    });
  }
  let needed = null;
  if (kind === "self") {
    const python = await pythonInvocation();
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
    if (python) {
      const trialDir = path.join(os.tmpdir(), `novaps5-compat-${process.pid}-${Date.now()}`);
      try {
        await fs.promises.mkdir(trialDir, { recursive: true });
        const outElf = path.join(trialDir, "eboot.elf");
        await unwrapSelf(eboot, outElf);
        needed = readNeeded(outElf);
        checks.push({
          id: "unwrap",
          label: "Eboot unwrap",
          status: "pass",
          detail: "Trial unwrap succeeded — the executable converts cleanly."
        });
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).replace(
          /^Unwrap failed — /,
          ""
        );
        checks.push({
          id: "unwrap",
          label: "Eboot unwrap",
          status: "fail",
          detail: `The eboot cannot be converted: ${detail}`
        });
      } finally {
        await fs.promises.rm(trialDir, { recursive: true, force: true }).catch(() => {
        });
      }
    }
  } else if (kind === "elf") {
    needed = readNeeded(eboot);
  }
  const tools = toolingPresent();
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
  const hasSingular = fs.existsSync(path.join(root, "sce_module"));
  const hasPlural = fs.existsSync(path.join(root, "sce_modules"));
  const hasPrxDir = fs.existsSync(path.join(root, "prx"));
  const moduleIssues = [];
  let moduleCount = 0;
  const moduleFileNames = /* @__PURE__ */ new Set();
  if (!hasSingular && !hasPlural && !hasPrxDir) {
    moduleIssues.push({
      id: "modules-none",
      label: "Modules",
      status: "fail",
      detail: "No sce_module/ folder — this dump ships no loadable modules for the converter."
    });
  } else {
    if (hasSingular && hasPlural) {
      moduleIssues.push({
        id: "modules-both",
        label: "Modules",
        status: "warn",
        detail: "Both sce_module/ and sce_modules/ exist — sce_modules/ will be merged into sce_module/ automatically."
      });
    }
    const rootDirs = [
      hasSingular ? "sce_module" : null,
      hasPlural ? "sce_modules" : null,
      hasPrxDir ? "prx" : null
    ].filter((dir) => dir !== null);
    const extraDirs = (await walkModuleDirs(root)).filter((dir) => !rootDirs.includes(dir));
    const dirs = [...rootDirs, ...extraDirs];
    const files = [];
    for (const rel of dirs) {
      let entries;
      try {
        entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(".guest.prx")) continue;
        const magic = await fileMagic(path.join(root, rel, entry.name));
        if (magic === "other") continue;
        files.push({ rel, name: entry.name, magic });
        moduleFileNames.add(entry.name.toLowerCase());
      }
    }
    const byName = /* @__PURE__ */ new Map();
    for (const file of files) {
      const folded = file.name.toLowerCase();
      const bucket = byName.get(folded);
      if (bucket) bucket.push(file);
      else byName.set(folded, [file]);
    }
    for (const [, bucket] of byName) {
      if (bucket.length < 2) continue;
      bucket.sort(
        (a, b) => moduleDirRank(a.rel) - moduleDirRank(b.rel) || a.rel.localeCompare(b.rel)
      );
      const locations = [...new Set(bucket.map((f) => `${f.rel}/${f.name}`))].join(" and ");
      moduleIssues.push({
        id: `modules-dup-${bucket[0].name.toLowerCase()}`,
        label: "Modules",
        status: "warn",
        detail: `Duplicate module "${bucket[0].name}" at ${locations} — the converter keeps the copy in ${bucket[0].rel}/ and skips the others.`
      });
    }
    const backups = files.filter((file) => isBackupName(file.name) || file.name.endsWith(".esbak"));
    if (backups.length > 0) {
      const shown = backups.slice(0, 3).map((f) => `${f.rel}/${f.name}`).join(", ");
      const more = backups.length > 3 ? ` (+${backups.length - 3} more)` : "";
      moduleIssues.push({
        id: "modules-backups",
        label: "Modules",
        status: "warn",
        detail: `Backup leftovers will be skipped during conversion: ${shown}${more}.`
      });
    }
    const strays = files.filter(
      (file) => !file.name.endsWith(".prx") && !isBackupName(file.name) && !file.name.endsWith(".esbak")
    );
    if (strays.length > 0) {
      const shown = strays.slice(0, 3).map((f) => `${f.rel}/${f.name}`).join(", ");
      const more = strays.length > 3 ? ` (+${strays.length - 3} more)` : "";
      moduleIssues.push({
        id: "modules-strays",
        label: "Modules",
        status: "warn",
        detail: `Module-like files without a .prx name will still be converted: ${shown}${more}.`
      });
    }
    moduleCount = files.length - backups.length;
  }
  if (moduleIssues.some((check) => check.status === "fail")) {
    checks.push(...moduleIssues.filter((check) => check.status === "fail"));
  } else {
    const clean = moduleIssues.length === 0;
    checks.push(
      ...moduleIssues,
      {
        id: "modules",
        label: "Modules",
        status: "pass",
        detail: clean ? `${moduleCount} loadable module${moduleCount === 1 ? "" : "s"} found — folders are consistent.` : `${moduleCount} loadable module${moduleCount === 1 ? "" : "s"} found — the notes above are reconciled during conversion.`
      }
    );
  }
  if (needed && needed.length > 0 && tools.libs) {
    const provided = /* @__PURE__ */ new Set();
    try {
      for (const entry of fs.readdirSync(runtimeLibsDir(), { withFileTypes: true })) {
        if (entry.isFile()) provided.add(normalizeLibName(entry.name));
      }
    } catch {
    }
    for (const name of moduleFileNames) provided.add(normalizeLibName(name));
    const missing = needed.filter((name) => !provided.has(normalizeLibName(name)));
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
        detail: `All ${needed.length} required librar${needed.length === 1 ? "y is" : "ies are"} provided by the runtime or the dump.`
      }
    );
  }
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
async function extractArchive(archive, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  const { code, stderr } = await run("tar", ["-xf", archive, "-C", dest], {
    timeoutMs: 30 * 60 * 1e3
  });
  if (code !== 0) {
    throw new Error(`Could not extract the archive — ${stderr.trim() || `tar exited with code ${code}`}`);
  }
}
async function resolveSource(sourcePath) {
  if (/\.(zip|rar|7z)$/i.test(sourcePath)) {
    const tempDir = path.join(electron.app.getPath("temp"), `ps5lib-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await extractArchive(sourcePath, tempDir);
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
    const compat = await checkCompatibility(root);
    return {
      isDump: true,
      name: meta.name,
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
    3221225620: "divide by zero",
    3221225786: "terminated (Ctrl+C or logoff)",
    3221225794: "DLL initialization failed",
    3221226505: "stack buffer overrun / fail-fast",
    3221226519: "invalid parameter / fail-fast"
  };
  const name = names[code >>> 0];
  return name ? `${hex} — ${name}` : hex;
}
function summarizeExit(code, signal, logPath) {
  let text = "";
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
  }
  const fatal = text.match(
    /^FATAL: unhandled exception (0x[0-9a-f]+)[^\n]*?on thread \d+ '([^']*)'/im
  );
  const rip = text.match(/^\s*rip \S+ (\S+)/m);
  if (fatal) {
    const fault = describeCode(parseInt(fatal[1], 16));
    const where = rip ? ` at ${rip[1]}` : "";
    const thread = fatal[2] ? `, thread '${fatal[2]}'` : "";
    return `crashed (${fault})${where}${thread}`;
  }
  if (signal) return `killed by ${signal}`;
  if (code === null) return "exited without an exit code";
  if (code === 0) return "exited immediately with code 0";
  if (code < 0 || code >= 3221225472) return `crashed (${describeCode(code)})`;
  const tail = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" · ");
  return tail ? `exited with code ${code} — ${tail}` : `exited with code ${code}`;
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
        finish({ state: "failed", detail: summarizeExit(code, signal, logPath) });
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
    emit("Checking compatibility…", 4, "validating");
    const compat = await checkCompatibility(dumpRoot);
    const blockers = formatBlockers(compat);
    if (blockers) throw new Error(`Not compatible — ${blockers}`);
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
      (entry) => !isBackup(entry.name) && !isBackupName(entry.name)
    );
    let total = 0;
    for (const entry of entries) total += await dirSize(path.join(dumpRoot, entry.name));
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
          await fs.promises.copyFile(src, dest);
          tick(followed.size);
        }
      } catch (error) {
        throw new Error(
          `Could not copy "${entry.name}" from the dump — ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
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
        if (rel !== "sce_module" && rel !== "sce_modules" && rel !== "prx") moduleDirs.push(rel);
      }
    };
    await scanForModules(installDir, "", 0);
    for (const rel of prxDirs) {
      const dir = path.join(installDir, rel);
      for (const file of await fs.promises.readdir(dir)) {
        if (isBackupName(file)) {
          await fs.promises.rm(path.join(dir, file), { force: true });
        }
      }
    }
    const pickup = [];
    for (const rel of prxDirs) {
      const dir = path.join(installDir, rel);
      for (const file of await fs.promises.readdir(dir).catch(() => [])) {
        const kind = detectContainer(path.join(dir, file));
        if (kind !== "elf" && kind !== "self") continue;
        pickup.push({ rel, file, folded: file.toLowerCase() });
      }
    }
    const keepRel = /* @__PURE__ */ new Map();
    for (const item of pickup) {
      const current = keepRel.get(item.folded);
      const better = current === void 0 || moduleDirRank(item.rel) < moduleDirRank(current) || moduleDirRank(item.rel) === moduleDirRank(current) && item.rel < current;
      if (better) keepRel.set(item.folded, item.rel);
    }
    for (const item of pickup) {
      if (keepRel.get(item.folded) !== item.rel) {
        await fs.promises.rm(path.join(installDir, item.rel, item.file), { force: true });
      }
    }
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
    emit("Launch test — starting the game…", 97, "launch-test");
    let probe2 = { state: "failed", detail: "the launch test could not start" };
    try {
      probe2 = await probeLaunch(path.join(finalDir, path.basename(exePath)), finalDir);
    } catch (error) {
      probe2 = { state: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
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
      installedAt: Date.now(),
      launchState: probe2.state,
      launchDetail: probe2.detail
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
function registerIpc(getWindow2) {
  electron.ipcMain.handle("app:info", () => appInfo());
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
      filters: [{ name: "PS5 dump archive", extensions: ["zip", "rar", "7z"] }]
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
  electron.ipcMain.handle("app:openExternal", async (_e, url) => {
    if (/^https?:\/\//i.test(url)) await electron.shell.openExternal(url);
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
