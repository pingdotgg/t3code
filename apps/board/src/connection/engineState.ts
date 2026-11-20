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
  /** Clones or refreshes the pstack-t3 checkout the board's Claude instances load, and returns its folder. */
  readonly ensurePstack: () => Promise<PstackResult>;
  readonly browser: BrowserHost;
}

export type PstackResult =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly reason: string };

export type FolderResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export interface BrowserTabState {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Where the active tab's page is drawn, in window coordinates. */
export interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The user's tabs, each a native page that the main process lays over the window. */
export interface BrowserHost {
  /** An empty url opens a blank tab. */
  readonly open: (id: string, url: string) => void;
  readonly close: (id: string) => void;
  /** Null hides every page. */
  readonly activate: (id: string | null) => void;
  readonly navigate: (id: string, url: string) => void;
  readonly history: (id: string, delta: -1 | 1) => void;
  readonly reload: (id: string) => void;
  /** Null hides the active page, which a hidden or collapsed panel needs. */
  readonly setBounds: (bounds: BrowserBounds | null) => void;
  readonly onTabState: (listener: (state: BrowserTabState) => void) => () => void;
}
