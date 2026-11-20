import type { BoardBridge, EngineState, EngineTokenResult, FolderResult } from "./engineState";

type EngineBridge = Pick<
  BoardBridge,
  | "engineState"
  | "onEngineState"
  | "engineToken"
  | "answerPrompt"
  | "pickFolder"
  | "resolveFolder"
  | "readLocalState"
  | "writeLocalState"
>;

// Without the main process there is no WSL to ask, so the engine rejects a folder that is missing.
function webFolder(text: string): FolderResult {
  const path = text.trim();
  if (/^\/mnt\/[a-z](\/|$)/.test(path) || /^([A-Za-z]:[\\/]|\\\\)/.test(path)) {
    return {
      ok: false,
      reason: "That folder is outside WSL. Pick one inside the Linux distro, such as /home.",
    };
  }
  return path.startsWith("/")
    ? { ok: true, path: path.replace(/\/+$/, "") || "/" }
    : { ok: false, reason: "Use an absolute WSL path, such as /home/me/project." };
}

const LOCAL_STATE_KEY = "board:local-state";

// `dev:web` has no Electron main process, so the lane scripts pass the engine and a token directly.
function webBridge(): EngineBridge {
  const url = import.meta.env.AGENT_BOARD_ENGINE_URL;
  const token = import.meta.env.AGENT_BOARD_TOKEN;
  const state: EngineState = url
    ? { phase: "ready", origin: new URL(url).origin, source: "url" }
    : {
        phase: "offline",
        reason: "Set AGENT_BOARD_ENGINE_URL to reach an engine from the browser.",
      };
  const result: EngineTokenResult = token
    ? { ok: true, token }
    : { ok: false, error: "unavailable", detail: "Set AGENT_BOARD_TOKEN." };
  return {
    engineState: () => Promise.resolve(state),
    onEngineState: () => () => undefined,
    engineToken: () => Promise.resolve(result),
    answerPrompt: () => undefined,
    pickFolder: () =>
      Promise.resolve({
        ok: false,
        reason: "The folder picker needs the desktop app. Type a WSL path instead.",
      }),
    resolveFolder: (text) => Promise.resolve(webFolder(text)),
    readLocalState: () => Promise.resolve(localStorage.getItem(LOCAL_STATE_KEY) ?? ""),
    writeLocalState: (text) => Promise.resolve(localStorage.setItem(LOCAL_STATE_KEY, text)),
  };
}

export const engineBridge: EngineBridge = window.board ?? webBridge();
