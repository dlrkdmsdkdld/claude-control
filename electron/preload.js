const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  pickApp: (title) => ipcRenderer.invoke("dialog:pickApp", title),
});
