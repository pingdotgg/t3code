/** How the app reached the engine. */
export type EngineRoute = "env" | "joined" | "booted";

export type EngineState =
  | { readonly phase: "connecting" }
  | { readonly phase: "starting" }
  | { readonly phase: "install-needed" }
  | { readonly phase: "ready"; readonly route: EngineRoute; readonly origin: string }
  | { readonly phase: "offline"; readonly reason: string };

export type EngineTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: "auth_failed" | "unavailable"; readonly detail: string };

/** What the preload script exposes on `window.board`. */
export interface BoardBridge {
  readonly reportFirstPaint: (epochMs: number) => void;
  readonly reportEngineConnected: (epochMs: number) => void;
  readonly engineState: () => Promise<EngineState>;
  readonly onEngineState: (listener: (state: EngineState) => void) => () => void;
  readonly engineToken: () => Promise<EngineTokenResult>;
  readonly answerInstall: (accepted: boolean) => void;
}
