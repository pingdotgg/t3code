/// <reference types="vite/client" />

import type { BoardBridge } from "./connection/engineState";

declare global {
  interface ImportMetaEnv {
    readonly AGENT_BOARD_ENGINE_URL?: string;
    readonly AGENT_BOARD_TOKEN?: string;
  }

  interface Window {
    /** Present only inside Electron. */
    board?: BoardBridge;
  }
}
