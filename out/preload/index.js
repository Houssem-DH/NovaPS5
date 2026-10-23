"use strict";
const electron = require("electron");
const api = {
  appInfo: () => electron.ipcRenderer.invoke("app:info"),
  displays: () => electron.ipcRenderer.invoke("app:displays"),
  selectFolder: () => electron.ipcRenderer.invoke("dialog:selectFolder"),
  selectArchive: () => electron.ipcRenderer.invoke("dialog:selectZip"),
  detect: (sourcePath) => electron.ipcRenderer.invoke("library:detect", sourcePath),
  list: () => electron.ipcRenderer.invoke("library:list"),
  scan: () => electron.ipcRenderer.invoke("library:scan"),
  install: (req) => electron.ipcRenderer.invoke("install:start", req),
  launch: (id) => electron.ipcRenderer.invoke("game:launch", id),
  session: (id) => electron.ipcRenderer.invoke("game:session", id),
  performance: (id) => electron.ipcRenderer.invoke("game:performance", id),
  remove: (id) => electron.ipcRenderer.invoke("game:remove", id),
  setGameGraphics: (id, patch) => electron.ipcRenderer.invoke("game:setGraphics", id, patch),
  setGameCompatibility: (id, patch) => electron.ipcRenderer.invoke("game:setCompatibility", id, patch),
  trophyPackage: (id) => electron.ipcRenderer.invoke("game:trophyPackage", id),
  clearShaderCache: (id) => electron.ipcRenderer.invoke("game:clearShaderCache", id),
  onInstallProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    electron.ipcRenderer.on("install:progress", listener);
    return () => electron.ipcRenderer.removeListener("install:progress", listener);
  },
  coverUrl: (game) => game.cover ? `media://library/${game.id}/${game.cover}` : null,
  runBootstrap: () => electron.ipcRenderer.invoke("bootstrap:run"),
  onBootstrapStep: (cb) => {
    const listener = (_event, step) => cb(step);
    electron.ipcRenderer.on("bootstrap:step", listener);
    return () => electron.ipcRenderer.removeListener("bootstrap:step", listener);
  },
  getSettings: () => electron.ipcRenderer.invoke("settings:get"),
  setGamesDir: (dir) => electron.ipcRenderer.invoke("settings:setGamesDir", dir),
  onOpenInstall: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("ui:install", listener);
    return () => electron.ipcRenderer.removeListener("ui:install", listener);
  },
  updateState: () => electron.ipcRenderer.invoke("update:state"),
  checkForUpdates: () => electron.ipcRenderer.invoke("update:check"),
  installUpdate: () => electron.ipcRenderer.invoke("update:install"),
  onUpdateState: (cb) => {
    const listener = (_event, state) => cb(state);
    electron.ipcRenderer.on("update:state", listener);
    return () => electron.ipcRenderer.removeListener("update:state", listener);
  },
  whatsNew: () => electron.ipcRenderer.invoke("update:whatsNew"),
  dismissWhatsNew: () => electron.ipcRenderer.invoke("update:dismissWhatsNew"),
  openExternal: (url) => electron.ipcRenderer.invoke("app:openExternal", url),
  openDisplaySettings: () => electron.ipcRenderer.invoke("app:openDisplaySettings"),
  // ---- Store ----------------------------------------------------------------
  storeRegions: () => electron.ipcRenderer.invoke("store:regions"),
  storeSettings: () => electron.ipcRenderer.invoke("store:settings:get"),
  storeSetSettings: (patch) => electron.ipcRenderer.invoke("store:settings:set", patch),
  storeBrowse: (query) => electron.ipcRenderer.invoke("store:browse", query),
  storeSearch: (query) => electron.ipcRenderer.invoke("store:search", query),
  storeFeatured: () => electron.ipcRenderer.invoke("store:featured"),
  storeLibrary: () => electron.ipcRenderer.invoke("store:library:list"),
  storeAdd: (game) => electron.ipcRenderer.invoke("store:add", game),
  storeRemove: (id) => electron.ipcRenderer.invoke("store:remove", id),
  storeSetDownload: (id, url) => electron.ipcRenderer.invoke("store:setDownload", id, url),
  storeDownload: (id, url) => electron.ipcRenderer.invoke("store:download", id, url),
  storeInstallLocal: (id, sourcePath) => electron.ipcRenderer.invoke("store:installLocal", id, sourcePath),
  storeCancelDownload: (jobId) => electron.ipcRenderer.invoke("store:cancel", jobId),
  onStoreProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    electron.ipcRenderer.on("store:progress", listener);
    return () => electron.ipcRenderer.removeListener("store:progress", listener);
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
