const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cursorDot", {
  getState: () => ipcRenderer.invoke("get-state"),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("state", handler);
    return () => ipcRenderer.removeListener("state", handler);
  },
  focusCursor: (projectLabel) => ipcRenderer.invoke("focus-cursor", projectLabel),
  setMouseIgnore: (ignore) => ipcRenderer.send("set-mouse-ignore", !!ignore),
  hide: () => ipcRenderer.send("hide-window"),
  clearFinished: () => ipcRenderer.send("clear-finished"),
  quit: () => ipcRenderer.send("quit-app"),
});
