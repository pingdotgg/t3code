import type { BrowserHost } from "../connection/engineState";

/** The user's native tabs, which exist only inside Electron. Web dev mode has none. */
export const browserHost: BrowserHost | null = window.board?.browser ?? null;
