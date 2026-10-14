var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/smoke-entry.ts
var import_electron3 = require("electron");
var import_path8 = __toESM(require("path"));

// src/main/pipeline/install.ts
var import_fs8 = __toESM(require("fs"));
var import_fs9 = require("fs");
var import_path7 = __toESM(require("path"));

// src/main/paths.ts
var import_electron = require("electron");
var import_path = __toESM(require("path"));
var import_fs = __toESM(require("fs"));
function toolsDir() {
  if (import_electron.app.isPackaged) {
    return import_path.default.join(process.resourcesPath, "tools");
  }
  return import_path.default.join(import_electron.app.getAppPath(), "resources", "tools");
}
function relinkerPath() {
  return import_path.default.join(toolsDir(), "relinker.exe");
}
function unwrapScriptPath() {
  return import_path.default.join(toolsDir(), "unwrap_self.py");
}
function runtimeLibsDir() {
  return import_path.default.join(toolsDir(), "libs");
}
function libraryRoot() {
  return import_path.default.join(import_electron.app.getPath("documents"), "PS5 Library");
}
function gamesRoot() {
  return import_path.default.join(libraryRoot(), "games");
}
function libraryFile() {
  return import_path.default.join(libraryRoot(), "library.json");
}
function ensureDir(dir) {
  import_fs.default.mkdirSync(dir, { recursive: true });
}

// src/main/pipeline/elf.ts
var import_fs2 = __toESM(require("fs"));
var SELF_MAGIC = Buffer.from([79, 21, 61, 29]);
var ELF_MAGIC = Buffer.from([127, 69, 76, 70]);
var PE_MAGIC = Buffer.from([77, 90]);
function detectContainer(file) {
  let fd;
  try {
    fd = import_fs2.default.openSync(file, "r");
    const buf = Buffer.alloc(4);
    const read = import_fs2.default.readSync(fd, buf, 0, 4, 0);
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
        import_fs2.default.closeSync(fd);
      } catch {
      }
    }
  }
}

// src/main/pipeline/unwrap.ts
var import_path2 = __toESM(require("path"));

// src/main/pipeline/run.ts
var import_child_process = require("child_process");
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = (0, import_child_process.spawn)(cmd, args, {
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

// src/main/python.ts
var import_child_process2 = require("child_process");
var import_util = require("util");
var execFileAsync = (0, import_util.promisify)(import_child_process2.execFile);
var cached;
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

// src/main/pipeline/unwrap.ts
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
    const detail = /not a SELF container/i.test(stderr) ? `${import_path2.default.basename(input)} is not a SELF container.` : /looks encrypted/i.test(stderr) ? `${import_path2.default.basename(input)} is still encrypted \u2014 dump it decrypted before converting.` : stderr.trim() || stdout.trim() || `exit code ${code}`;
    throw new Error(`Unwrap failed \u2014 ${detail}`);
  }
}

// src/main/pipeline/relink.ts
async function relink(inputElf, outputExe, onOutput, cwd) {
  const { code, stdout, stderr } = await run(
    relinkerPath(),
    ["--windows", inputElf, outputExe],
    { onOutput, cwd, timeoutMs: 30 * 60 * 1e3 }
  );
  if (code !== 0) {
    const detail = extractFailure(`${stderr}
${stdout}`) ?? `relinker exited with code ${code}`;
    throw new Error(`Conversion failed \u2014 ${detail}`);
  }
  return { stdout, stderr };
}

// src/main/pipeline/copy.ts
var import_fs3 = require("fs");
var import_path3 = __toESM(require("path"));
async function dirSize(target) {
  let stat;
  try {
    stat = await import_fs3.promises.stat(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const entries = await import_fs3.promises.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    total += await dirSize(import_path3.default.join(target, entry.name));
  }
  return total;
}
async function copyDir(src, dest, onBytes) {
  await import_fs3.promises.mkdir(dest, { recursive: true });
  const entries = await import_fs3.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const from = import_path3.default.join(src, entry.name);
    const to = import_path3.default.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, onBytes);
    } else if (entry.isFile()) {
      const stat = await import_fs3.promises.stat(from);
      await import_fs3.promises.copyFile(from, to);
      onBytes(stat.size);
    }
  }
}

// src/main/pipeline/layout.ts
var import_fs4 = require("fs");
var import_path4 = __toESM(require("path"));
async function buildLayout(installDir, keepAtRoot = []) {
  const app0 = import_path4.default.join(installDir, "app0");
  await import_fs4.promises.mkdir(app0, { recursive: true });
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
  for (const entry of await import_fs4.promises.readdir(installDir, { withFileTypes: true })) {
    if (exclude.has(entry.name) || entry.name.endsWith(".esbak")) continue;
    const src = import_path4.default.join(installDir, entry.name);
    const dest = import_path4.default.join(app0, entry.name);
    try {
      await import_fs4.promises.rename(src, dest);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not move ${entry.name} into app0 \u2014 ${detail}`);
    }
  }
  const libsLink = import_path4.default.join(installDir, "libs");
  try {
    await import_fs4.promises.rm(libsLink, { recursive: true, force: true });
  } catch {
  }
  await import_fs4.promises.symlink(runtimeLibsDir(), libsLink, "junction");
}

// src/main/pipeline/dump.ts
var import_fs5 = __toESM(require("fs"));
var import_fs6 = require("fs");
var import_path5 = __toESM(require("path"));
var import_electron2 = require("electron");
function looksLikeDump(dir) {
  return import_fs5.default.existsSync(import_path5.default.join(dir, "eboot.bin")) || import_fs5.default.existsSync(import_path5.default.join(dir, "sce_sys"));
}
async function locateDumpRoot(dir, depth = 0) {
  if (depth > 4) return null;
  if (looksLikeDump(dir)) return dir;
  let entries;
  try {
    entries = await import_fs6.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await locateDumpRoot(import_path5.default.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}
async function readMeta(sourceDir) {
  let name2 = import_path5.default.basename(sourceDir);
  let titleId = null;
  let hasCover = false;
  try {
    const raw = await import_fs6.promises.readFile(import_path5.default.join(sourceDir, "sce_sys", "param.json"), "utf8");
    const json = JSON.parse(raw);
    if (typeof json.titleId === "string") titleId = json.titleId;
    const lp = json.localizedParameters;
    if (lp && typeof lp === "object") {
      const lang = typeof lp.defaultLanguage === "string" ? lp.defaultLanguage : "en-US";
      const title = lp[lang]?.titleName ?? lp["en-US"]?.titleName;
      if (typeof title === "string" && title.trim()) name2 = title.trim();
    }
  } catch {
  }
  try {
    await import_fs6.promises.access(import_path5.default.join(sourceDir, "sce_sys", "icon0.png"));
    hasCover = true;
  } catch {
  }
  return { name: name2, titleId, hasCover };
}
async function extractZip(zip, dest) {
  await import_fs6.promises.mkdir(dest, { recursive: true });
  const { code, stderr } = await run("tar", ["-xf", zip, "-C", dest], {
    timeoutMs: 30 * 60 * 1e3
  });
  if (code !== 0) {
    throw new Error(`Could not extract the archive \u2014 ${stderr.trim() || `tar exited with code ${code}`}`);
  }
}
async function resolveSource(sourcePath) {
  if (/\.zip$/i.test(sourcePath)) {
    const tempDir = import_path5.default.join(import_electron2.app.getPath("temp"), `ps5lib-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await extractZip(sourcePath, tempDir);
    const root2 = await locateDumpRoot(tempDir) ?? tempDir;
    return { root: root2, tempDir };
  }
  const root = await locateDumpRoot(sourcePath) ?? sourcePath;
  return { root, tempDir: null };
}

// src/main/library.ts
var import_fs7 = require("fs");
var import_path6 = __toESM(require("path"));
var cache = null;
async function load() {
  if (cache) return cache;
  try {
    const raw = await import_fs7.promises.readFile(libraryFile(), "utf8");
    const parsed = JSON.parse(raw);
    cache = { games: Array.isArray(parsed.games) ? parsed.games : [] };
  } catch {
    cache = { games: [] };
  }
  return cache;
}
async function persist() {
  if (!cache) return;
  ensureDir(import_path6.default.dirname(libraryFile()));
  await import_fs7.promises.writeFile(libraryFile(), JSON.stringify(cache, null, 2), "utf8");
}
function slugify(name2) {
  const slug = name2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "game";
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
    await import_fs7.promises.rm(game.installPath, { recursive: true, force: true }).catch(() => {
    });
  }
}

// src/main/pipeline/install.ts
function isBackup(name2) {
  return name2.endsWith(".esbak");
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
    emit("Validating source\u2026", 2, "validating");
    const resolved = await resolveSource(sourcePath);
    tempDir = resolved.tempDir;
    const dumpRoot = resolved.root;
    if (!import_fs8.default.existsSync(import_path7.default.join(dumpRoot, "eboot.bin"))) {
      throw new Error("No eboot.bin found \u2014 this does not look like a PS5 game dump.");
    }
    const meta = await readMeta(dumpRoot);
    const name2 = (nameOverride?.trim() || meta.name).slice(0, 90);
    const baseId = slugify(name2);
    const owned = await getGame(baseId);
    const sameTitle = !!owned && !!meta.titleId && owned.titleId === meta.titleId;
    let id = baseId;
    if (!sameTitle) {
      let n = 2;
      const taken = async (candidate) => !!await getGame(candidate) || import_fs8.default.existsSync(import_path7.default.join(gamesRoot(), candidate));
      while (await taken(id)) id = `${baseId}-${n++}`;
    }
    const installDir = import_path7.default.join(gamesRoot(), id);
    createdId = id;
    await import_fs9.promises.rm(installDir, { recursive: true, force: true });
    ensureDir(installDir);
    const entries = (await import_fs9.promises.readdir(dumpRoot, { withFileTypes: true })).filter(
      (entry) => !isBackup(entry.name)
    );
    let total = 0;
    for (const entry of entries) total += await dirSize(import_path7.default.join(dumpRoot, entry.name));
    let copied = 0;
    let lastCopyEmit = 0;
    emit("Copying game data\u2026", 8, "copying");
    for (const entry of entries) {
      const src = import_path7.default.join(dumpRoot, entry.name);
      const dest = import_path7.default.join(installDir, entry.name);
      const stat = await import_fs9.promises.stat(src);
      const tick = (n) => {
        copied += n;
        const pct = total > 0 ? 8 + Math.min(42, copied / total * 42) : 8;
        const now = Date.now();
        if (pct - percent >= 1 || now - lastCopyEmit > 400) {
          lastCopyEmit = now;
          emit(`Copying ${entry.name}\u2026`, pct, "copying");
        }
      };
      if (entry.isDirectory()) await copyDir(src, dest, tick);
      else if (entry.isFile()) {
        await import_fs9.promises.copyFile(src, dest);
        tick(stat.size);
      }
    }
    const ebootDest = import_path7.default.join(installDir, "eboot.bin");
    const inputElf = import_path7.default.join(installDir, "input.elf");
    if (detectContainer(ebootDest) === "self") {
      emit("Unwrapping eboot (SELF \u2192 ELF)\u2026", 55, "unwrapping-eboot");
      await unwrapSelf(ebootDest, inputElf);
    } else {
      await import_fs9.promises.copyFile(ebootDest, inputElf);
    }
    emit("Preparing modules\u2026", 60, "preparing-modules");
    const modDir = import_path7.default.join(installDir, "sce_module");
    if (import_fs8.default.existsSync(modDir)) {
      for (const file of await import_fs9.promises.readdir(modDir)) {
        const filePath = import_path7.default.join(modDir, file);
        if (file.endsWith(".esbak")) {
          await import_fs9.promises.rm(filePath, { force: true });
          continue;
        }
        if (!file.endsWith(".prx")) continue;
        if (detectContainer(filePath) === "self") {
          emit(`Unwrapping ${file}\u2026`, 60, "preparing-modules");
          await unwrapSelf(filePath, filePath);
        }
      }
    }
    emit("Converting to a Windows executable\u2026", 68, "relinking");
    const safeName = name2.replace(/[\\/:*?"<>|]/g, "").trim() || "game";
    const exePath = import_path7.default.join(installDir, `${safeName}.exe`);
    await relink(inputElf, exePath, void 0, installDir);
    emit("Building runtime layout\u2026", 88, "building-layout");
    await buildLayout(installDir, [import_path7.default.basename(exePath), "cover.png"]);
    let cover = null;
    try {
      await import_fs9.promises.copyFile(
        import_path7.default.join(installDir, "app0", "sce_sys", "icon0.png"),
        import_path7.default.join(installDir, "cover.png")
      );
      cover = "cover.png";
    } catch {
    }
    emit("Finalizing\u2026", 95, "finalizing");
    await import_fs9.promises.rm(ebootDest, { force: true });
    await import_fs9.promises.rm(inputElf, { force: true });
    await import_fs9.promises.rm(modDir, { recursive: true, force: true });
    if (tempDir) {
      await import_fs9.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
      });
      tempDir = null;
    }
    const sizeBytes = await dirSize(installDir);
    const game = {
      id,
      name: name2,
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
    report({ jobId, step: "done", message: "Ready to play", percent: 100, status: "done", gameId: id, gameName: name2 });
    return game;
  } catch (error) {
    if (tempDir) await import_fs9.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
    });
    if (createdId) {
      await removeGame(createdId).catch(() => {
      });
      await import_fs9.promises.rm(import_path7.default.join(gamesRoot(), createdId), { recursive: true, force: true }).catch(() => {
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    report({ jobId, step, message: "Failed", percent, status: "error", error: message });
    throw error;
  }
}

// scripts/smoke-entry.ts
import_electron3.app.setAppPath(import_path8.default.resolve(__dirname, ".."));
var source = process.argv[2];
var name = process.argv[3];
if (!source) {
  console.error("usage: electron .smoke.cjs <dump-folder> [name]");
  import_electron3.app.exit(2);
}
import_electron3.app.whenReady().then(async () => {
  try {
    const game = await installGame(
      source,
      name,
      (p) => {
        const label = p.status === "error" ? ` ERROR ${p.error ?? ""}` : "";
        process.stdout.write(`[${String(p.percent).padStart(3, "0")}%] ${p.step}: ${p.message}${label}
`);
      },
      "smoke"
    );
    console.log(
      "SMOKE OK " + JSON.stringify(
        { id: game.id, name: game.name, titleId: game.titleId, exe: game.exePath, size: game.sizeBytes, cover: game.cover },
        null,
        2
      )
    );
    import_electron3.app.exit(0);
  } catch (error) {
    console.error("SMOKE FAILED:", error instanceof Error ? error.message : String(error));
    import_electron3.app.exit(1);
  }
});
