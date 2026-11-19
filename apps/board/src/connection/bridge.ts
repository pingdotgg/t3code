import type { BoardBridge, EngineState, EngineTokenResult } from "./engineState";

type EngineBridge = Pick<
  BoardBridge,
  "engineState" | "onEngineState" | "engineToken" | "answerPrompt"
>;

// `dev:web` has no Electron main process, so the lane scripts pass the engine and a token directly.
function webBridge(): EngineBridge {
  const url = import.meta.env.AGENT_BOARD_ENGINE_URL;
  const token = import.meta.env.AGENT_BOARD_TOKEN;
  const state: EngineState = url
    ? { phase: "ready", origin: new URL(url).origin }
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
  };
}

export const engineBridge: EngineBridge = window.board ?? webBridge();
