export type EngineState =
  | { readonly phase: "connecting" }
  | { readonly phase: "starting" }
  | { readonly phase: "installing" }
  | { readonly phase: "updating" }
  | { readonly phase: "install-needed" }
  | { readonly phase: "update-needed"; readonly found: string }
  | {
      readonly phase: "ready";
      readonly origin: string;
      /** `url` for an engine named by `AGENT_BOARD_ENGINE_URL`, which the app never updates. */
      readonly source: "service" | "url";
    }
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
  /** Answers the install or update question the footer is asking. */
  readonly answerPrompt: (accepted: boolean) => void;
  /** Shows the folder dialog in the user's WSL home. Null when the user cancels. */
  readonly pickFolder: () => Promise<FolderResult | null>;
  /** Checks a typed folder and returns its path inside WSL. */
  readonly resolveFolder: (text: string) => Promise<FolderResult>;
  /** The text of the file in the app's user data folder, empty when there is none. */
  readonly readLocalState: () => Promise<string>;
  readonly writeLocalState: (text: string) => Promise<void>;
}

export type FolderResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };
