import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS, type NativeApi } from "@acme/contracts";

const nativeApi: NativeApi = {
  todos: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.todosList),
    add: (input) => ipcRenderer.invoke(IPC_CHANNELS.todosAdd, input),
    toggle: (id) => ipcRenderer.invoke(IPC_CHANNELS.todosToggle, id),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.todosRemove, id),
  },
  terminal: {
    run: (input) => ipcRenderer.invoke(IPC_CHANNELS.terminalRun, input),
  },
  agent: {
    spawn: (config) => ipcRenderer.invoke(IPC_CHANNELS.agentSpawn, config),
    kill: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.agentKill, sessionId),
    write: (sessionId, data) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentWrite, sessionId, data),
    onOutput: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, chunk: unknown) =>
        callback(chunk as Parameters<typeof callback>[0]);
      ipcRenderer.on(IPC_CHANNELS.agentOutput, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.agentOutput, listener);
    },
    onExit: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, exit: unknown) =>
        callback(exit as Parameters<typeof callback>[0]);
      ipcRenderer.on(IPC_CHANNELS.agentExit, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.agentExit, listener);
    },
  },
  providers: {
    startSession: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.providerSessionStart, input),
    sendTurn: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.providerTurnStart, input),
    interruptTurn: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.providerTurnInterrupt, input),
    stopSession: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.providerSessionStop, input),
    listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.providerSessionList),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) =>
        callback(payload as Parameters<typeof callback>[0]);
      ipcRenderer.on(IPC_CHANNELS.providerEvent, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.providerEvent, listener);
    },
  },
};

contextBridge.exposeInMainWorld("nativeApi", nativeApi);
