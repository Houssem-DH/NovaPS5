"use strict";
const electron = require("electron");
const api = {
  appInfo: () => electron.ipcRenderer.invoke("app:info"),
  selectFolder: () => electron.ipcRenderer.invoke("dialog:selectFolder"),
  selectArchive: () => electron.ipcRenderer.invoke("dialog:selectZip"),
  detect: (sourcePath) => electron.ipcRenderer.invoke("library:detect", sourcePath),
  list: () => electron.ipcRenderer.invoke("library:list"),
  install: (req) => electron.ipcRenderer.invoke("install:start", req),
  launch: (id) => electron.ipcRenderer.invoke("game:launch", id),
  remove: (id) => electron.ipcRenderer.invoke("game:remove", id),
  onInstallProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    electron.ipcRenderer.on("install:progress", listener);
    return () => electron.ipcRenderer.removeListener("install:progress", listener);
  },
  coverUrl: (game) => game.cover ? `media://library/${game.id}/${game.cover}` : null
};
electron.contextBridge.exposeInMainWorld("api", api);
