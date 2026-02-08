import { fixPath } from "./fixPath";
fixPath();

import { spawn } from "node:child_process";
import path from "node:path";
import { BrowserWindow, app, dialog, ipcMain, session } from "electron";

import {
  IPC_CHANNELS,
  type TerminalCommandInput,
  type TerminalCommandResult,
  agentConfigSchema,
  agentSessionIdSchema,
  newTodoInputSchema,
  terminalCommandInputSchema,
  todoIdSchema,
} from "@acme/contracts";
import { ProcessManager } from "./processManager";
import { ProviderManager } from "./providerManager";
import { TodoStore } from "./todoStore";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

let todoStore: TodoStore;
const processManager = new ProcessManager();
const providerManager = new ProviderManager();

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.once("ready-to-show", () => {
    window.show();
  });

  setupEventForwarding(window);

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    return window;
  }

  void window.loadFile(path.join(__dirname, "../../renderer/dist/index.html"));
  return window;
}

function registerIpcHandlers(): void {
  // Todo handlers
  ipcMain.handle(IPC_CHANNELS.todosList, async () => {
    return todoStore.list();
  });

  ipcMain.handle(IPC_CHANNELS.todosAdd, async (_event, payload: unknown) => {
    return todoStore.add(newTodoInputSchema.parse(payload));
  });

  ipcMain.handle(IPC_CHANNELS.todosToggle, async (_event, id: unknown) => {
    return todoStore.toggle(todoIdSchema.parse(id));
  });

  ipcMain.handle(IPC_CHANNELS.todosRemove, async (_event, id: unknown) => {
    return todoStore.remove(todoIdSchema.parse(id));
  });

  ipcMain.handle(IPC_CHANNELS.dialogPickFolder, async () => {
    const owner =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });

    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  // Terminal handlers
  ipcMain.handle(IPC_CHANNELS.terminalRun, async (_event, payload: unknown) => {
    return runTerminalCommand(terminalCommandInputSchema.parse(payload));
  });

  // Agent handlers
  ipcMain.handle(IPC_CHANNELS.agentSpawn, async (_event, config: unknown) => {
    return processManager.spawn(agentConfigSchema.parse(config));
  });

  ipcMain.handle(IPC_CHANNELS.agentKill, async (_event, sessionId: unknown) => {
    processManager.kill(agentSessionIdSchema.parse(sessionId));
  });

  ipcMain.handle(
    IPC_CHANNELS.agentWrite,
    async (_event, sessionId: unknown, data: unknown) => {
      processManager.write(agentSessionIdSchema.parse(sessionId), String(data));
    },
  );

  // Provider handlers
  ipcMain.handle(
    IPC_CHANNELS.providerSessionStart,
    async (_event, payload: unknown) => {
      return providerManager.startSession(
        payload as Parameters<typeof providerManager.startSession>[0],
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.providerTurnStart,
    async (_event, payload: unknown) => {
      return providerManager.sendTurn(
        payload as Parameters<typeof providerManager.sendTurn>[0],
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.providerTurnInterrupt,
    async (_event, payload: unknown) => {
      await providerManager.interruptTurn(
        payload as Parameters<typeof providerManager.interruptTurn>[0],
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.providerSessionStop,
    async (_event, payload: unknown) => {
      providerManager.stopSession(
        payload as Parameters<typeof providerManager.stopSession>[0],
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.providerSessionList, async () => {
    return providerManager.listSessions();
  });
}

async function runTerminalCommand(
  input: TerminalCommandInput,
): Promise<TerminalCommandResult> {
  const shellPath =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");

  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", input.command]
      : ["-lc", input.command];

  return new Promise((resolve, reject) => {
    const child = spawn(shellPath, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000).unref();
    }, input.timeoutMs ?? 30_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        code: code ?? null,
        signal: signal ?? null,
        timedOut,
      });
    });
  });
}

function setupEventForwarding(window: BrowserWindow): void {
  const onOutput = (chunk: unknown) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.agentOutput, chunk);
    }
  };

  const onExit = (exit: unknown) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.agentExit, exit);
    }
  };

  const onProviderEvent = (event: unknown) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.providerEvent, event);
    }
  };

  processManager.on("output", onOutput);
  processManager.on("exit", onExit);
  providerManager.on("event", onProviderEvent);

  window.on("closed", () => {
    processManager.off("output", onOutput);
    processManager.off("exit", onExit);
    providerManager.off("event", onProviderEvent);
  });
}

function setupCSP(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDevelopment
      ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

async function bootstrap(): Promise<void> {
  setupCSP();

  todoStore = new TodoStore(path.join(app.getPath("userData"), "todos.json"));
  await todoStore.init();

  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.on("before-quit", () => {
  processManager.killAll();
  providerManager.stopAll();
});

app.whenReady().then(() => {
  void bootstrap();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
