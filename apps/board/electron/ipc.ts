import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";

import { runtimeSupportsClient } from "./runtimeCompatibility";
import { createEngine, type EngineConfig, type TokenStore } from "./engine";
import { createLocalStateFile } from "./localState";
import { pickFolder, resolveFolder } from "./pickFolder";
import {
  createLinuxHost,
  type LinuxHost,
  nodeProcessRunner,
  resolveDistro,
  type RunningProcess,
} from "./wslEngine";

// The renderer reports wall-clock time because its performance clock starts at navigation.
// process.getCreationTime() is skewed under WSL (it once came out negative), so the clock
// starts at Node's init in the main process instead.
const isEpochMs = (value: unknown): value is number => Number.isFinite(value);
const sinceStart = (epochMs: number) => Math.round(epochMs - performance.timeOrigin);

const Settings = Schema.Struct({ wslDistro: Schema.optional(Schema.String) });
const TokenFile = Schema.Record(Schema.String, Schema.String);
const decodeText = Schema.decodeUnknownOption(Schema.String);
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Settings));
const decodeTokenFile = Schema.decodeUnknownOption(Schema.fromJsonString(TokenFile));

const readFileOrEmpty = (file: string): string => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const readDistroSetting = (file: string): string | undefined =>
  Option.getOrUndefined(
    Option.map(decodeSettings(readFileOrEmpty(file)), (settings) => settings.wslDistro),
  );

// Tokens are bearer credentials, so they stay encrypted at rest. Without an OS keystore they live
// only for this run and the next launch issues a fresh one.
function createTokenStore(file: string): TokenStore {
  const memory = new Map<string, string>();
  const load = (): Record<string, string> =>
    Option.getOrElse(decodeTokenFile(readFileOrEmpty(file)), () => ({}));
  return {
    read: (key) => {
      const cached = memory.get(key);
      if (cached !== undefined) return cached;
      const stored = load()[key];
      if (stored === undefined || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(stored, "base64"));
      } catch {
        return null;
      }
    },
    write: (key, token) => {
      memory.set(key, token);
      if (!safeStorage.isEncryptionAvailable()) return;
      const stored = load();
      stored[key] = safeStorage.encryptString(token).toString("base64");
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, JSON.stringify(stored));
    },
  };
}

export function configFromEnv(env: NodeJS.ProcessEnv, distro: string | undefined): EngineConfig {
  return {
    engineUrl: env["AGENT_BOARD_ENGINE_URL"] || undefined,
    envToken: env["AGENT_BOARD_TOKEN"] || undefined,
    t3Home: env["AGENT_BOARD_T3_HOME"] || undefined,
    t3Cli: env["AGENT_BOARD_T3_CLI"] || undefined,
    distro,
  };
}

export interface EngineHandle {
  readonly start: () => void;
  /** Ends the idle process that keeps WSL running. T3's service keeps running. */
  readonly release: () => void;
}

export function registerEngineIpc(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): EngineHandle {
  const { env, platform } = options;
  const userData = app.getPath("userData");
  const distroSetting =
    env["AGENT_BOARD_WSL_DISTRO"] || readDistroSetting(NodePath.join(userData, "settings.json"));

  // A failed distro lookup rejects every host call, which the engine reports as Offline.
  const hostReady: Promise<LinuxHost> = (
    platform === "win32" ? resolveDistro(nodeProcessRunner, distroSetting) : Promise.resolve(null)
  ).then((distro) => createLinuxHost({ platform, distro, runner: nodeProcessRunner }));
  hostReady.catch(() => undefined);
  const host: Pick<LinuxHost, "exec" | "shell"> = {
    exec: async (argv, execOptions) => (await hostReady).exec(argv, execOptions),
    shell: async (script, shellOptions) => (await hostReady).shell(script, shellOptions),
  };

  let answer: ((accepted: boolean) => void) | null = null;
  const engine = createEngine({
    config: configFromEnv(env, distroSetting),
    runtimeCompatible: runtimeSupportsClient,
    host,
    fetch: globalThis.fetch,
    tokens: createTokenStore(NodePath.join(userData, "engine-tokens.json")),
    confirm: () => {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      answer = resolve;
      return promise;
    },
    log: (message) => console.log(`board:engine ${message}`),
    sleep: (ms) => NodeTimersPromises.setTimeout(ms),
  });

  engine.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("board:engine-state", state);
    }
  });
  ipcMain.handle("board:engine-state", () => engine.state());
  ipcMain.handle("board:engine-token", () => engine.token());
  ipcMain.on("board:prompt-answer", (_event, accepted) => {
    answer?.(accepted === true);
    answer = null;
  });
  ipcMain.handle("board:pick-folder", (event) =>
    pickFolder({
      host,
      platform,
      choose: async (startAt) => {
        const parent = BrowserWindow.fromWebContents(event.sender);
        const dialogOptions = {
          title: "Add project",
          properties: ["openDirectory" as const],
          ...(startAt === undefined ? {} : { defaultPath: startAt }),
        };
        const chosen = parent
          ? await dialog.showOpenDialog(parent, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
      },
    }),
  );
  ipcMain.handle("board:resolve-folder", (_event, text) =>
    resolveFolder(
      host,
      Option.getOrElse(decodeText(text), () => ""),
    ),
  );
  const localState = createLocalStateFile(NodePath.join(userData, "local-state.json"));
  ipcMain.handle("board:local-state-read", () => localState.read());
  ipcMain.handle("board:local-state-write", (_event, text) => {
    const contents = Option.getOrUndefined(decodeText(text));
    if (contents !== undefined) localState.write(contents);
  });
  ipcMain.on("board:engine-connected", (_event, epochMs) => {
    if (isEpochMs(epochMs)) console.log(`board:engine-connected ${sinceStart(epochMs)} ms`);
  });
  ipcMain.on("board:first-paint", (_event, epochMs) => {
    if (isEpochMs(epochMs)) console.log(`board:first-paint ${sinceStart(epochMs)} ms`);
  });

  let held: RunningProcess | null = null;
  return {
    start: () => {
      void hostReady.then((ready) => {
        held = ready.hold();
      });
      void engine.start();
    },
    release: () => held?.kill(),
  };
}
