# In‑App Preview Browser — Implementation Plan

> **Scope**: A Chromium‑backed preview browser slot in the chat workspace, available **only in the desktop build**. Web build shows nothing for this feature (no iframe fallback). Server tracks per‑thread preview session metadata so it survives reconnects and multi‑window/multi‑client. Reachable via three vectors: a keybinding, a "Open in preview" affordance on terminal URLs, and a `ProjectScript.previewUrl/autoOpenPreview` extension.
>
> **Reference implementation we're modelling on**: ami's `packages/desktop/src/browser-view-manager.ts` + `packages/interface/src/components/browser-view/`. We're porting a deliberately smaller subset.
>
> **Done in one shot**: this is a single multi‑PR‑sized landing. Below is the file‑by‑file checklist.

---

## 1. Architecture

### Three‑actor model

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         apps/server (Node, Effect)                         │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ PreviewManager — Map<scopedThreadKey, PreviewSession>                │  │
│  │   • metadata only: { tabId, url, title, navStatus, lastError, … }    │  │
│  │   • broadcasts PreviewEvent over WS                                  │  │
│  │   • survives client disconnect, replays on reconnect                 │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
                              ▲                  │
                  EnvironmentApi.preview         │ preview.onEvent push
                  (WS RPC)                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                  apps/desktop (Electron renderer = apps/web)               │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ PreviewView (React) — chrome (URL bar, back/fwd/refresh)             │  │
│  │   ┌────────────────────────────────────────────────────────────────┐ │  │
│  │   │ <webview partition="persist:t3code-preview" preload=…/>        │ │  │
│  │   └────────────────────────────────────────────────────────────────┘ │  │
│  │  zustand: previewStateStore (mirrors terminalStateStore)             │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
                              ▲                  │
              desktopBridge.preview.*            │ desktopBridge.preview.onStateChange
              (Electron IPC)                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       apps/desktop main process (Node)                     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ PreviewViewManager — Map<tabId, TabRecord{ webContents, state }>     │  │
│  │   • createTab/closeTab/navigate/registerWebview/setVisibility        │  │
│  │   • attaches did-navigate / did-fail-load / page-title-updated       │  │
│  │   • partitioned session: persist:t3code-preview                      │  │
│  │   • forwards app shortcuts to mainWindow (mod+w, mod+, mod+1..9, …)  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

### Why the server even cares

The desktop already has the `<webview>` and could be the sole source of truth. We route through the server anyway because:

1. Reconnect/restart resilience matches the rest of t3code — terminal sessions, orchestration, etc. all use snapshot+replay.
2. A future second window or a remote viewer (e.g. mobile observer) sees the same URL the desktop is on.
3. Agent‑facing tooling (later) is RPC‑shaped and lives on the server, not the desktop bridge.

### Why the renderer subscribes to two streams

- **Server `preview.onEvent`** — authoritative for `url`, `title`, `lastError`. Replays on WS reconnect.
- **`desktopBridge.preview.onStateChange`** — authoritative for low‑latency `canGoBack`, `canGoForward`, `loading`. Cheaper than round‑tripping through the server.

The web side merges them in `previewStateStore.applyServerEvent` / `applyDesktopState`.

### Web build behaviour

When `window.desktopBridge?.preview == null`:

- `previewStateStore` selectors return a frozen "unsupported" shape.
- `PreviewPanel.tsx` short‑circuits to `null` (panel never renders).
- `rightPanelStore` rejects `kind: "preview"` writes.
- `preview.toggle` keybinding fires a toast: _"Preview is only available in the T3 Code desktop app."_
- Terminal‑link "Open in preview" menu item is hidden (only "Open in browser" shows).
- `ProjectScript.previewUrl` is still **stored** (so it round‑trips between web/desktop users of the same project) but ignored.

---

## 2. Right‑panel arbiter (prerequisite refactor)

Today the right side has two implicit tenants and no arbiter:

- **Diff panel** — driven by URL `?diff=1` (`apps/web/src/diffRouteSearch.ts`). Toggle wired to `diff.toggle` keybinding.
- **Plan sidebar** — driven by local component state `planSidebarOpen` in `ChatView.tsx:688`. Renders inline (sibling div) when wide and as `<RightPanelSheet>` when narrow.

They co‑exist by accident. With a third panel we need an explicit arbiter.

### New: `apps/web/src/rightPanelStore.ts`

```ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { type ScopedThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import { resolveStorage } from "./lib/storage";

export type RightPanelKind = "plan" | "diff" | "preview";

interface ThreadRightPanelState {
  /** null = closed; otherwise the active panel for this thread */
  active: RightPanelKind | null;
}

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v1";

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  open: (ref: ScopedThreadRef, kind: RightPanelKind) => void;
  close: (ref: ScopedThreadRef) => void;
  toggle: (ref: ScopedThreadRef, kind: RightPanelKind) => void;
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(/* … */, {
    name: RIGHT_PANEL_STORAGE_KEY,
    storage: createJSONStorage(() => resolveStorage(window.localStorage)),
    version: 1,
  }),
);

export function selectActiveRightPanel(
  store: RightPanelStoreState,
  ref: ScopedThreadRef | null,
): RightPanelKind | null {
  if (!ref) return null;
  return store.byThreadKey[scopedThreadKey(ref)]?.active ?? null;
}
```

### Diff panel migration

`?diff=1` stays the URL source of truth (deep‑linking matters for diff). On router navigation, mirror it into `rightPanelStore`:

- `parseDiffRouteSearch(...).diff === "1"` → `rightPanelStore.open(activeThreadRef, "diff")` in a `useEffect`.
- Opening plan/preview removes the `?diff` param via `stripDiffSearchParams` (already exists in `apps/web/src/diffRouteSearch.ts`).
- Closing diff via the X button does both: navigate to strip `?diff=1` **and** call `rightPanelStore.close(...)`.

### Plan sidebar migration

`apps/web/src/components/ChatView.tsx`:

- Remove the local `planSidebarOpen` state (`:688`).
- Replace `setPlanSidebarOpen(true)` callsites with `rightPanelStore.open(activeThreadRef, "plan")`.
- Replace `closePlanSidebar` with `rightPanelStore.close(activeThreadRef)`.
- Existing `planSidebarDismissedForTurnRef`/`planSidebarOpenOnNextThreadRef` logic stays local — it only governs whether to _call_ `open()`/`close()` on turn change.

### Render arbitration

The single render decision in `ChatView.tsx`:

```tsx
const activeRightPanel = useRightPanelStore((s) =>
  selectActiveRightPanel(s, activeThreadRef),
);
const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);

// Inline (wide):
{activeRightPanel === "plan" && !useSheet && <PlanSidebar mode="sidebar" … />}
{activeRightPanel === "preview" && !useSheet && <PreviewPanel mode="sidebar" … />}
{/* DiffPanel inline rendering already lives in DiffPanelShell, just gate it on activeRightPanel === "diff" */}

// Sheet (narrow):
{useSheet && activeRightPanel !== null && (
  <RightPanelSheet open onClose={() => rightPanelStore.close(activeThreadRef)}>
    {activeRightPanel === "plan" && <PlanSidebar mode="sheet" … />}
    {activeRightPanel === "diff" && <DiffPanel mode="sheet" … />}
    {activeRightPanel === "preview" && <PreviewPanel mode="sheet" … />}
  </RightPanelSheet>
)}
```

---

## 3. File map

### NEW files

| File                                                         | Purpose                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `packages/contracts/src/preview.ts`                          | Effect/Schema schemas: inputs, snapshot, events, errors                 |
| `packages/contracts/src/preview.test.ts`                     | Schema round‑trip tests                                                 |
| `apps/server/src/preview/Services/Manager.ts`                | `PreviewManager` Service tag + interface                                |
| `apps/server/src/preview/Layers/Manager.ts`                  | Implementation: in‑memory map + event subject                           |
| `apps/server/src/preview/Layers/Manager.test.ts`             | Lifecycle, snapshot, event ordering                                     |
| `apps/desktop/src/preview-view-manager.ts`                   | Plain‑Node Electron port of ami's BrowserManager (subset)               |
| `apps/desktop/src/preview-preload.ts`                        | Webview preload (no‑op v1)                                              |
| `apps/web/src/previewStateStore.ts`                          | Per‑thread zustand store (mirrors `terminalStateStore.ts`)              |
| `apps/web/src/previewStateStore.test.ts`                     | Reducer tests                                                           |
| `apps/web/src/rightPanelStore.ts`                            | Right‑panel arbiter                                                     |
| `apps/web/src/rightPanelStore.test.ts`                       | Arbiter tests                                                           |
| `apps/web/src/components/preview/PreviewPanel.tsx`           | Right‑panel entry (wraps `PreviewPanelShell`)                           |
| `apps/web/src/components/preview/PreviewPanelShell.tsx`      | Shell mirroring `DiffPanelShell` (`mode: "inline"\|"sheet"\|"sidebar"`) |
| `apps/web/src/components/preview/PreviewView.tsx`            | Chrome bar (URL/back/fwd/refresh) + `<PreviewWebview>`                  |
| `apps/web/src/components/preview/PreviewWebview.tsx`         | Electron `<webview>` host; null on web build                            |
| `apps/web/src/components/preview/PreviewEmptyState.tsx`      | Pre‑URL empty state                                                     |
| `apps/web/src/components/preview/PreviewUnsupportedToast.ts` | `"Preview is only available in the desktop app"` toast                  |

### MODIFIED files

| File                                                                  | Change                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/keybindings.ts`                               | Add `preview.toggle`, `preview.refresh`, `preview.focusUrl` to `STATIC_KEYBINDING_COMMANDS`; add `previewFocus`, `previewOpen` to context keys                                                                    |
| `packages/contracts/src/project.ts`                                   | Add `previewUrl?: string` and `autoOpenPreview?: boolean` to `ProjectScript` schema                                                                                                                               |
| `packages/contracts/src/server.ts`                                    | Extend `EnvironmentApi` with `preview` namespace                                                                                                                                                                  |
| `packages/contracts/src/index.ts`                                     | Re‑export new types                                                                                                                                                                                               |
| `apps/server/src/keybindings.ts`                                      | Add defaults: `mod+shift+j` → `preview.toggle`, `mod+shift+r` → `preview.refresh` (when `previewFocus`)                                                                                                           |
| `apps/server/src/ws.ts`                                               | Route `preview.open`, `preview.navigate`, `preview.refresh`, `preview.close`, `preview.list`, `preview.onEvent`                                                                                                   |
| `apps/server/src/orchestration/runtimeLayer.ts` (or equivalent)       | Provide `PreviewManager.Default`                                                                                                                                                                                  |
| `apps/web/src/environmentApi.ts`                                      | Wire `preview` slot in `createEnvironmentApi`                                                                                                                                                                     |
| `apps/web/src/keybindings.ts`                                         | Add `isPreviewToggleShortcut`, `isPreviewRefreshShortcut` helpers                                                                                                                                                 |
| `apps/web/src/routes/_chat.tsx`                                       | Handle `preview.toggle` in global shortcut handler                                                                                                                                                                |
| `apps/web/src/components/ChatView.tsx`                                | Replace local `planSidebarOpen` with `rightPanelStore`; render `PreviewPanel`                                                                                                                                     |
| `apps/web/src/components/ThreadTerminalDrawer.tsx`                    | At terminal link activation, when `match.kind === "url"` and link looks like a dev URL, show context menu with "Open in preview" / "Open in browser"; pass through to `localApi.preview.openTab(...)` when chosen |
| `apps/web/src/components/ProjectScriptsControl.tsx`                   | Add `previewUrl` + `autoOpenPreview` form fields in the Add/Edit dialog                                                                                                                                           |
| `apps/web/src/projectScripts.ts`                                      | Carry the new fields through `commandForProjectScript` / serialization                                                                                                                                            |
| `apps/web/src/types.ts`                                               | Add `PreviewSession` mirror types (or re‑export from contracts)                                                                                                                                                   |
| `apps/web/src/lib/desktopBridge.d.ts` (or wherever bridge types live) | Add `preview` namespace shape                                                                                                                                                                                     |
| `apps/desktop/src/main.ts`                                            | Register `preview:*` IPC handlers; instantiate `previewViewManager`; wire `mainWindow` injection                                                                                                                  |
| `apps/desktop/src/preload.ts`                                         | Expose `desktopBridge.preview.*`                                                                                                                                                                                  |
| `KEYBINDINGS.md`                                                      | Document new commands and `previewFocus`/`previewOpen` `when` keys                                                                                                                                                |

### NOT changed

- `apps/web/src/components/DiffPanel.tsx` — unchanged, its open/close just becomes mediated by `rightPanelStore`. The `?diff=1` URL truth is preserved via a sync effect.
- `apps/web/src/components/PlanSidebar.tsx` — unchanged surface; consumer in `ChatView.tsx` is what changes.
- `packages/contracts/src/terminal.ts` — terminal stays single‑tab, no schema changes.

---

## 4. Schemas (`packages/contracts/src/preview.ts`)

```ts
import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PreviewTabId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewTabId = typeof PreviewTabId.Type;

export const PreviewNavStatus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Idle") }),
  Schema.Struct({
    _tag: Schema.Literal("Loading"),
    url: TrimmedNonEmptyString,
    title: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Success"),
    url: TrimmedNonEmptyString,
    title: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("LoadFailed"),
    url: TrimmedNonEmptyString,
    title: Schema.String,
    code: Schema.Int,
    description: Schema.String,
  }),
]);
export type PreviewNavStatus = typeof PreviewNavStatus.Type;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  updatedAt: Schema.String,
});
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type;

export const PreviewOpenInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export const PreviewNavigateInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  url: TrimmedNonEmptyString,
});
export const PreviewRefreshInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
});
export const PreviewCloseInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: Schema.optional(PreviewTabId),
});

const PreviewEventBase = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  createdAt: Schema.String,
});

export const PreviewEvent = Schema.Union([
  Schema.Struct({
    ...PreviewEventBase.fields,
    type: Schema.Literal("opened"),
    snapshot: PreviewSessionSnapshot,
  }),
  Schema.Struct({
    ...PreviewEventBase.fields,
    type: Schema.Literal("navigated"),
    snapshot: PreviewSessionSnapshot,
  }),
  Schema.Struct({
    ...PreviewEventBase.fields,
    type: Schema.Literal("failed"),
    code: Schema.Int,
    description: Schema.String,
  }),
  Schema.Struct({
    ...PreviewEventBase.fields,
    type: Schema.Literal("closed"),
  }),
]);
export type PreviewEvent = typeof PreviewEvent.Type;

export class PreviewSessionLookupError extends Schema.TaggedErrorClass<PreviewSessionLookupError>()(
  "PreviewSessionLookupError",
  { threadId: Schema.String, tabId: Schema.String },
) {
  override get message() {
    return `Unknown preview session: thread=${this.threadId}, tab=${this.tabId}`;
  }
}

export class PreviewInvalidUrlError extends Schema.TaggedErrorClass<PreviewInvalidUrlError>()(
  "PreviewInvalidUrlError",
  { rawUrl: Schema.String },
) {
  override get message() {
    return `Invalid preview URL: ${this.rawUrl}`;
  }
}

export const PreviewError = Schema.Union([PreviewSessionLookupError, PreviewInvalidUrlError]);
export type PreviewError = typeof PreviewError.Type;
```

### `ProjectScript` extension (`packages/contracts/src/project.ts`)

Add to the existing `ProjectScript` struct (additive, default both fields to undefined/false at runtime so existing persisted scripts decode unchanged):

```ts
previewUrl: Schema.optional(TrimmedNonEmptyString),
autoOpenPreview: Schema.optional(Schema.Boolean),
```

### Keybindings (`packages/contracts/src/keybindings.ts:50`)

```ts
const STATIC_KEYBINDING_COMMANDS = [
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
  "terminal.close",
  "diff.toggle",
  "preview.toggle", // NEW
  "preview.refresh", // NEW
  "preview.focusUrl", // NEW
  "commandPalette.toggle",
  "chat.new",
  "chat.newLocal",
  "editor.openFavorite",
] as const;
```

Add `previewFocus` and `previewOpen` to the `ShortcutMatchContext` union (`apps/web/src/keybindings.ts:30`).

### Defaults (`apps/server/src/keybindings.ts`)

```ts
{ key: "mod+shift+j", command: "preview.toggle" },
{ key: "mod+r", command: "preview.refresh", when: "previewFocus" },
{ key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
```

---

## 5. Server: PreviewManager

### `apps/server/src/preview/Services/Manager.ts`

```ts
import { Context, Effect } from "effect";
import {
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";

export interface PreviewManagerShape {
  readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
  readonly navigate: (
    input: PreviewNavigateInput,
  ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
  readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
  readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
  readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<PreviewSessionSnapshot>>;
  readonly subscribe: (
    listener: (event: PreviewEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}

export class PreviewManager extends Context.Service<PreviewManager, PreviewManagerShape>()(
  "t3/preview/Services/Manager/PreviewManager",
) {}
```

### `apps/server/src/preview/Layers/Manager.ts`

In‑memory `Map<threadId, PreviewSession>` keyed by `threadId` (single tab per thread for v1; the schema has `tabId` so we can grow to multi‑tab without a migration). Maintains a subscriber set; emits events with monotonic `createdAt` from `Date.now().toISOString()`.

URL normalization mirrors ami's helper (`browser-view-manager.ts:655`):

```ts
const normalizeUrl = (input: string) =>
  Effect.try(() => {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("empty");
    // localhost stays http unless explicitly https
    const useHttp = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(trimmed);
    const parsed = urlParseLax(trimmed, { https: !useHttp });
    if (!parsed?.href) throw new Error("unparseable");
    return parsed.href;
  }).pipe(
    Effect.catchAll((cause) => Effect.fail(new PreviewInvalidUrlError({ rawUrl: input, cause }))),
  );
```

### `apps/server/src/ws.ts` routes

Following the existing terminal route pattern, expose:

```ts
preview: {
  open: (input) => Effect.runPromise(previewManager.open(input)),
  navigate: (input) => Effect.runPromise(previewManager.navigate(input)),
  refresh: (input) => Effect.runPromise(previewManager.refresh(input)),
  close: (input) => Effect.runPromise(previewManager.close(input)),
  list: (threadId) => Effect.runPromise(previewManager.list(threadId)),
  onEvent: (callback) => /* subscribe + return unsubscribe */,
}
```

---

## 6. Desktop: `PreviewViewManager`

### Style

`apps/desktop/src/main.ts` is plain Node/Electron with no Effect — for parity, **drop Effect in `preview-view-manager.ts`**. Use plain async/await + a small typed‑error class style consistent with the rest of `apps/desktop`.

### `apps/desktop/src/preview-view-manager.ts`

Subset of ami's `BrowserManager`:

```ts
import * as path from "node:path";
import { type BrowserWindow, type Session, session, webContents } from "electron";

const PREVIEW_PARTITION = "persist:t3code-preview";

export type NavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | { kind: "LoadFailed"; url: string; title: string; code: number; description: string };

export interface TabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: NavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
  updatedAt: string;
}

type Listener = (tabId: string, state: TabState) => void;

export class PreviewViewManager {
  private mainWindow: BrowserWindow | null = null;
  private readonly tabs = new Map<string, TabState>();
  private browserSession: Session | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly preloadPath: string;

  constructor() {
    this.preloadPath = path.join(__dirname, "preview-preload.cjs");
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  getPreloadPath(): string {
    return this.preloadPath;
  }
  getBrowserPartition(): string {
    return PREVIEW_PARTITION;
  }

  getBrowserSession(): Session {
    if (this.browserSession) return this.browserSession;
    const sess = session.fromPartition(PREVIEW_PARTITION);
    // strip electron/t3code from UA so dev preview doesn't trip bot detection
    const ua = sess
      .getUserAgent()
      .replace(/Electron\/[\d.]+ /, "")
      .replace(/\s*t3code\/[\d.]+/, "");
    sess.setUserAgent(ua);
    sess.setPermissionRequestHandler((_wc, perm, callback) => {
      const allow = ["clipboard-read", "clipboard-write", "notifications", "geolocation"];
      callback(allow.includes(perm));
    });
    this.browserSession = sess;
    return sess;
  }

  createTab(tabId: string): TabState {
    if (this.tabs.has(tabId)) return this.tabs.get(tabId)!;
    const initial: TabState = {
      tabId,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      visible: true,
      updatedAt: new Date().toISOString(),
    };
    this.tabs.set(tabId, initial);
    this.emit(tabId, initial);
    return initial;
  }

  closeTab(tabId: string): void {
    if (!this.tabs.delete(tabId)) return;
    this.emit(tabId, { ...this.tabs.get(tabId)!, navStatus: { kind: "Idle" } });
  }

  setVisibility(tabId: string, visible: boolean): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (tab.visible === visible) return;
    this.update(tabId, { visible });
  }

  registerWebview(tabId: string, webContentsId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new PreviewTabNotFoundError(tabId);
    const wc = webContents.fromId(webContentsId);
    if (!wc) throw new PreviewWebContentsNotFoundError(tabId, webContentsId);

    this.attachListeners(tabId, wc);
    this.update(tabId, {
      webContentsId,
      navStatus: this.computeNavStatus(wc),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  }

  unregisterWebview(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.update(tabId, {
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
    });
  }

  async navigate(tabId: string, rawUrl: string): Promise<void> {
    const wc = this.requireWebContents(tabId);
    const url = this.normalizeUrl(rawUrl);
    if (wc.getURL() === url) return;
    await wc.loadURL(url);
  }

  goBack(tabId: string): void {
    this.requireWebContents(tabId).navigationHistory.goBack();
  }
  goForward(tabId: string): void {
    this.requireWebContents(tabId).navigationHistory.goForward();
  }
  refresh(tabId: string): void {
    this.requireWebContents(tabId).reload();
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private attachListeners(tabId: string, wc: Electron.WebContents): void {
    const sync = () => {
      this.update(tabId, {
        navStatus: this.computeNavStatus(wc),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    };
    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("page-title-updated", sync);
    wc.on("did-start-loading", sync);
    wc.on("did-stop-loading", sync);
    wc.on("did-fail-load", (_event, code, description) => {
      if (code === -3) return; // user aborted
      this.update(tabId, {
        navStatus: {
          kind: "LoadFailed",
          url: wc.getURL(),
          title: wc.getTitle(),
          code,
          description,
        },
      });
    });

    // External link policy: load in same view (matches ami)
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url);
      return { action: "deny" };
    });

    // Forward app shortcuts to the main window so mod+shift+j etc still work
    wc.on("before-input-event", (event, input) => {
      if (this.isAppShortcut(input) && this.mainWindow && !this.mainWindow.isDestroyed()) {
        event.preventDefault();
        this.mainWindow.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: input.key,
          modifiers: [
            ...(input.meta ? ["meta" as const] : []),
            ...(input.shift ? ["shift" as const] : []),
            ...(input.control ? ["control" as const] : []),
            ...(input.alt ? ["alt" as const] : []),
          ],
        });
      }
    });
  }

  private isAppShortcut(input: Electron.Input): boolean {
    if (input.type !== "keyDown") return false;
    // Mirror the t3code keybinding defaults that should always reach the main window.
    const SHORTCUTS = [
      { key: "j", meta: true, shift: true }, // preview.toggle
      { key: "k", meta: true, shift: false }, // commandPalette.toggle
      { key: ",", meta: true, shift: false }, // settings
      { key: "w", meta: true, shift: false }, // close
      // future: terminal.* if user wants them while preview focused
    ];
    return SHORTCUTS.some(
      (s) =>
        s.key.toLowerCase() === input.key.toLowerCase() &&
        s.meta === input.meta &&
        s.shift === input.shift,
    );
  }

  private computeNavStatus(wc: Electron.WebContents): NavStatus {
    const url = wc.getURL();
    const title = wc.getTitle();
    if (url === "" || url === "about:blank") return { kind: "Idle" };
    if (wc.isLoading()) return { kind: "Loading", url, title };
    return { kind: "Success", url, title };
  }

  private requireWebContents(tabId: string): Electron.WebContents {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new PreviewTabNotFoundError(tabId);
    if (tab.webContentsId == null) throw new PreviewWebviewNotInitializedError(tabId);
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc) throw new PreviewWebContentsNotFoundError(tabId, tab.webContentsId);
    return wc;
  }

  private update(tabId: string, patch: Partial<TabState>): void {
    const current = this.tabs.get(tabId);
    if (!current) return;
    const next: TabState = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.tabs.set(tabId, next);
    this.emit(tabId, next);
  }

  private emit(tabId: string, state: TabState): void {
    for (const listener of this.listeners) listener(tabId, state);
  }

  private normalizeUrl(input: string): string {
    // Same heuristics as server-side normalization.
    // Returns "https://..." or throws.
    const trimmed = input.trim();
    if (!trimmed) throw new PreviewInvalidUrlError(input);
    const useHttp = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(trimmed);
    const parsed = new URL(
      trimmed.includes("://") ? trimmed : `${useHttp ? "http" : "https"}://${trimmed}`,
    );
    return parsed.href;
  }
}

export class PreviewTabNotFoundError extends Error {
  constructor(public readonly tabId: string) {
    super(`Preview tab not found: ${tabId}`);
  }
}
export class PreviewWebContentsNotFoundError extends Error {
  /* … */
}
export class PreviewWebviewNotInitializedError extends Error {
  /* … */
}
export class PreviewInvalidUrlError extends Error {
  /* … */
}

export const previewViewManager = new PreviewViewManager();
```

### `apps/desktop/src/main.ts` additions

Right after `mainWindow = createWindow();` in `bootstrap()` and after every recreation:

```ts
previewViewManager.setMainWindow(mainWindow);
```

Register IPC handlers (in `registerIpcHandlers()`):

```ts
ipcMain.handle("preview:createTab", (_e, tabId: string) => previewViewManager.createTab(tabId));
ipcMain.handle("preview:closeTab", (_e, tabId: string) => previewViewManager.closeTab(tabId));
ipcMain.handle("preview:setVisibility", (_e, tabId: string, visible: boolean) =>
  previewViewManager.setVisibility(tabId, visible),
);
ipcMain.handle("preview:registerWebview", (_e, tabId: string, wcId: number) =>
  previewViewManager.registerWebview(tabId, wcId),
);
ipcMain.handle("preview:unregisterWebview", (_e, tabId: string) =>
  previewViewManager.unregisterWebview(tabId),
);
ipcMain.handle("preview:navigate", (_e, tabId: string, url: string) =>
  previewViewManager.navigate(tabId, url),
);
ipcMain.handle("preview:goBack", (_e, tabId: string) => previewViewManager.goBack(tabId));
ipcMain.handle("preview:goForward", (_e, tabId: string) => previewViewManager.goForward(tabId));
ipcMain.handle("preview:refresh", (_e, tabId: string) => previewViewManager.refresh(tabId));
ipcMain.handle("preview:getPreloadPath", () => previewViewManager.getPreloadPath());
ipcMain.handle("preview:getBrowserPartition", () => previewViewManager.getBrowserPartition());
```

State change broadcast (push to all renderer windows):

```ts
previewViewManager.onStateChange((tabId, state) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("preview:state-change", tabId, state);
  }
});
```

### `apps/desktop/src/preload.ts` additions

```ts
contextBridge.exposeInMainWorld("desktopBridge", {
  // … existing fields …
  preview: {
    createTab: (tabId: string) => ipcRenderer.invoke("preview:createTab", tabId),
    closeTab: (tabId: string) => ipcRenderer.invoke("preview:closeTab", tabId),
    setVisibility: (tabId: string, visible: boolean) =>
      ipcRenderer.invoke("preview:setVisibility", tabId, visible),
    registerWebview: (tabId: string, wcId: number) =>
      ipcRenderer.invoke("preview:registerWebview", tabId, wcId),
    unregisterWebview: (tabId: string) => ipcRenderer.invoke("preview:unregisterWebview", tabId),
    navigate: (tabId: string, url: string) => ipcRenderer.invoke("preview:navigate", tabId, url),
    goBack: (tabId: string) => ipcRenderer.invoke("preview:goBack", tabId),
    goForward: (tabId: string) => ipcRenderer.invoke("preview:goForward", tabId),
    refresh: (tabId: string) => ipcRenderer.invoke("preview:refresh", tabId),
    getPreloadPath: (): Promise<string> => ipcRenderer.invoke("preview:getPreloadPath"),
    getBrowserPartition: (): Promise<string> => ipcRenderer.invoke("preview:getBrowserPartition"),
    onStateChange: (cb: (tabId: string, state: DesktopPreviewTabState) => void) => {
      const listener = (_e: unknown, tabId: string, state: DesktopPreviewTabState) =>
        cb(tabId, state);
      ipcRenderer.on("preview:state-change", listener);
      return () => ipcRenderer.removeListener("preview:state-change", listener);
    },
  },
});
```

### `apps/desktop/src/preview-preload.ts`

```ts
// Intentionally empty for v1.
// Future: forward console.error to main, expose a tiny window.t3preview API.
```

Build config: add `preview-preload.ts` to `apps/desktop/tsdown.config.ts` outputs so it ships as `preview-preload.cjs` next to `preload.cjs`.

---

## 7. Web: state stores

### `apps/web/src/previewStateStore.ts`

Direct mirror of `terminalStateStore.ts` shape (one tab per thread for v1; structured to grow into multi‑tab the same way terminal grew into groups).

```ts
import { type ScopedThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { PreviewEvent, PreviewSessionSnapshot } from "@t3tools/contracts";
import { resolveStorage } from "./lib/storage";

interface ThreadPreviewState {
  /** present if a preview tab exists for this thread */
  snapshot: PreviewSessionSnapshot | null;
  /** desktop-side immediate nav button state (overrides snapshot when fresher) */
  desktopOverlay: {
    canGoBack: boolean;
    canGoForward: boolean;
    visible: boolean;
  } | null;
  /** local UI: is the URL bar focused? */
  urlBarFocused: boolean;
  recentEventIds: number[];
}

interface PreviewEventEntry { id: number; event: PreviewEvent }

interface PreviewStateStore {
  byThreadKey: Record<string, ThreadPreviewState>;
  recentEvents: Record<string, ReadonlyArray<PreviewEventEntry>>;
  nextEventId: number;
  applyServerEvent: (ref: ScopedThreadRef, event: PreviewEvent) => void;
  applyDesktopState: (
    ref: ScopedThreadRef,
    overlay: ThreadPreviewState["desktopOverlay"],
  ) => void;
  setUrlBarFocused: (ref: ScopedThreadRef, focused: boolean) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const PERSISTED_FIELDS = ["byThreadKey"] as const;
const STORAGE_KEY = "t3code:preview-state:v1";

export const usePreviewStateStore = create<PreviewStateStore>()(
  persist(/* … */, {
    name: STORAGE_KEY,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    version: 1,
    partialize: (s) => Object.fromEntries(PERSISTED_FIELDS.map((k) => [k, s[k]])),
  }),
);

export function selectThreadPreviewState(
  byThreadKey: Record<string, ThreadPreviewState>,
  ref: ScopedThreadRef | null,
): ThreadPreviewState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}
```

Key invariants (test in `previewStateStore.test.ts`):

- `applyServerEvent("opened" | "navigated" | "failed")` updates `snapshot`; pushes into `recentEvents` ring buffer (cap 50).
- `applyServerEvent("closed")` removes the thread entry entirely.
- `applyDesktopState` only updates `desktopOverlay`; never touches `snapshot.url`/`title` (server is truth for those).

### `apps/web/src/environmentApi.ts`

```ts
preview: {
  open: (input) => rpcClient.preview.open(input as never),
  navigate: (input) => rpcClient.preview.navigate(input as never),
  refresh: (input) => rpcClient.preview.refresh(input as never),
  close: (input) => rpcClient.preview.close(input as never),
  list: (threadId) => rpcClient.preview.list(threadId),
  onEvent: (callback) => rpcClient.preview.onEvent(callback),
},
```

Plus mirror in the `EnvironmentApi` shape in `packages/contracts/src/server.ts` (or wherever `EnvironmentApi` lives).

---

## 8. Web: components

### `apps/web/src/components/preview/PreviewPanelShell.tsx`

Lifted from `DiffPanelShell.tsx` verbatim, renamed types. **Must** use the same className contract:

```tsx
<div
  className={cn(
    "flex h-full min-w-0 flex-col bg-background",
    props.mode === "inline"
      ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
      : "w-full",
  )}
>
```

So preview side panel is visually indistinguishable in spacing from the diff panel.

### `apps/web/src/components/preview/PreviewView.tsx`

Renderer of chrome bar + `<PreviewWebview>`. Direct port of ami's `browser-view.tsx` chrome (URL bar with protocol/host/path split, back/fwd/refresh/loading bar) but stripped of: devtools button, screenshot button, runtime errors badge, react-grab. Uses `lucide-react` icons that t3code already depends on (`ArrowLeft`, `ArrowRight`, `RefreshCw`, `X`) instead of `@hugeicons/react`.

Key behaviour:

- On mount: `await desktopBridge.preview.createTab(tabId)`, `await desktopBridge.preview.getPreloadPath()`.
- Subscribes to `desktopBridge.preview.onStateChange(handleState)` → `previewStateStore.applyDesktopState`.
- Subscribes to `EnvironmentApi.preview.onEvent(handleEvent)` → `previewStateStore.applyServerEvent`.
- On `<webview>` `dom-ready`: read `webContentsId`, call `desktopBridge.preview.registerWebview`, then call `EnvironmentApi.preview.navigate({ threadId, tabId, url })` so server learns the resolved URL.
- On unmount when panel hides (not when thread changes — see persistence note below): `setVisibility(tabId, false)`.

### `apps/web/src/components/preview/PreviewWebview.tsx`

```tsx
"use client";

import { useEffect, useState } from "react";
import { isDesktop } from "~/env";

interface Props {
  tabId: string;
  initialUrl: string | null;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: Electron.WebviewTag;
  }
}

export function PreviewWebview({ tabId, initialUrl }: Props) {
  const [config, setConfig] = useState<{ partition: string; preload: string } | null>(null);

  useEffect(() => {
    if (!isDesktop || !window.desktopBridge?.preview) return;
    void Promise.all([
      window.desktopBridge.preview.getBrowserPartition(),
      window.desktopBridge.preview.getPreloadPath(),
    ]).then(([partition, preload]) => setConfig({ partition, preload }));
  }, []);

  if (!isDesktop || !window.desktopBridge?.preview || !config) return null;

  const src = initialUrl ?? "about:blank";
  return (
    <webview
      src={src}
      partition={config.partition}
      preload={`file://${config.preload}`}
      allowpopups
      data-preview-tab={tabId}
      className="absolute inset-0 h-full w-full bg-background"
    />
  );
}
```

### `apps/web/src/components/preview/PreviewPanel.tsx`

The right‑panel entrypoint. Reads `previewStateStore` for the active thread; renders `<PreviewView>` if a session exists, otherwise `<PreviewEmptyState>` with a URL field that calls `EnvironmentApi.preview.open(...)` on submit.

### Persistence across thread changes

Following `PersistentThreadTerminalDrawer` pattern (`ChatView.tsx:3517`): keep multiple `<PreviewPanel>` instances mounted (capped, e.g. `MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3`) and toggle `visible` via `desktopBridge.preview.setVisibility`. The `<webview>` element stays alive in the DOM but the desktop side knows it's hidden so it can later (v2) skip raster updates.

For v1 the simpler version: only mount the active thread's `<PreviewPanel>`. Closing the right panel calls `desktopBridge.preview.setVisibility(tabId, false)` but does **not** close the tab. Switching threads closes the previous thread's tab. This matches the desktop‑only constraint and avoids hidden `<webview>`s eating GPU.

---

## 9. Discoverability glue

### A. `preview.toggle` keybinding (`apps/web/src/routes/_chat.tsx`)

Mirror the existing `chat.new` block (`:51–:78`):

```ts
if (command === "preview.toggle") {
  event.preventDefault();
  event.stopPropagation();
  if (!window.desktopBridge?.preview) {
    showPreviewUnsupportedToast();
    return;
  }
  if (!routeThreadRef) return;
  rightPanelStore.toggle(routeThreadRef, "preview");
  return;
}
```

`previewFocus` and `previewOpen` `when` context keys get computed in the global shortcut handler so `mod+r` (refresh) only matches when the preview is the active right panel and focused.

### B. Terminal link → "Open in preview"

In `ThreadTerminalDrawer.tsx`'s `terminal.registerLinkProvider({ provideLinks })` callback (`:454–:514`), update the `activate(event)` handler:

```ts
activate: (event: MouseEvent) => {
  if (!isTerminalLinkActivation(event)) return;
  if (match.kind !== "url") {
    // existing path link handling
    return;
  }
  if (!isPreviewable(match.text) || !window.desktopBridge?.preview) {
    void localApi.shell.openExternal(match.text).catch(/* … */);
    return;
  }
  void localApi.contextMenu
    .show(
      [
        { id: "open-in-preview", label: "Open in preview" },
        { id: "open-in-browser", label: "Open in browser" },
      ],
      { x: event.clientX, y: event.clientY },
    )
    .then((choice) => {
      if (choice === "open-in-preview") {
        void api.preview.open({ threadId, url: match.text });
        rightPanelStore.open(threadRef, "preview");
      } else if (choice === "open-in-browser") {
        void localApi.shell.openExternal(match.text);
      }
    });
},
```

`isPreviewable`: localhost / 127.0.0.1 / 0.0.0.0 by default. The `previewUrlPatterns` user setting (a `string[]` in `ServerSettings`) extends the allowlist to cover deploy preview hosts (e.g. `*.vercel.app`).

### C. `ProjectScript.previewUrl` / `autoOpenPreview`

Schema additions are listed in §4. UI changes in `ProjectScriptsControl.tsx`'s Add/Edit dialog form (`:378–:458`):

```tsx
<div className="space-y-1.5">
  <Label htmlFor="script-preview-url">Preview URL (optional)</Label>
  <Input
    id="script-preview-url"
    placeholder="http://localhost:5173"
    value={previewUrl}
    onChange={(e) => setPreviewUrl(e.target.value)}
  />
  <p className="text-xs text-muted-foreground">
    Auto-open this URL in the preview panel when the script starts.
  </p>
</div>
<label className="flex items-center justify-between …">
  <span>Open preview automatically when this script runs</span>
  <Switch checked={autoOpenPreview} onCheckedChange={setAutoOpenPreview} />
</label>
```

When `onRunScript(script)` fires in `ChatView.tsx`, after starting the terminal command, if `script.autoOpenPreview && script.previewUrl && desktopBridge.preview`:

```ts
void api.preview.open({ threadId: activeThread.id, url: script.previewUrl });
rightPanelStore.open(activeThreadRef, "preview");
```

---

## 10. Migrations

### Persisted state

- `t3code:preview-state:v1` — new key, no migration needed.
- `t3code:right-panel-state:v1` — new key, no migration needed.
- Existing `t3code:terminal-state:v1` — untouched.

### Schema additions

`ProjectScript.previewUrl` and `autoOpenPreview` are both `Schema.optional(...)`. Existing serialized scripts decode unchanged. No data migration required.

### Keybindings

Adding `preview.toggle`, `preview.refresh`, `preview.focusUrl` to `STATIC_KEYBINDING_COMMANDS` is additive. Existing user `~/.t3/keybindings.json` files keep working. Default keybindings file picks up the new defaults on next read.

---

## 11. Testing strategy

Following t3code's vitest patterns (`bun run test`, never `bun test`):

| Test file                                                                                                | What it covers                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/preview.test.ts`                                                                 | Schema encode/decode round-trips for inputs, snapshot, events; URL trimming; error tagged unions                                                                                               |
| `apps/server/src/preview/Layers/Manager.test.ts`                                                         | `open` creates session and emits `opened`; `navigate` updates and emits `navigated`; `close` removes and emits `closed`; subscribers receive monotonic events; `list` returns sorted snapshots |
| `apps/web/src/previewStateStore.test.ts`                                                                 | `applyServerEvent` reducer correctness; ring buffer cap; `closed` removes entry; `desktopOverlay` is independent of snapshot fields                                                            |
| `apps/web/src/rightPanelStore.test.ts`                                                                   | `open` / `close` / `toggle` semantics; per-thread isolation; `?diff=1` sync compatibility                                                                                                      |
| `apps/web/src/components/preview/PreviewView.test.ts` (logic-only via `PreviewView.logic.ts` extraction) | URL bar input → navigation; navigation button enabled-state derivation; visibility toggle on panel hide                                                                                        |
| Existing `ThreadTerminalDrawer.test.ts`                                                                  | Add a case: link activation with `kind: "url"` and `previewable: true` shows the context menu (mock `localApi.contextMenu.show`)                                                               |

Manual smoke checklist (drop in `apps/desktop/test/smoke/`):

1. Boot desktop dev, open a thread, hit `mod+shift+j` → empty state appears in right panel.
2. Type `https://example.com` → page loads, title updates in chrome bar.
3. Navigate to `https://example.org` → back/forward enable correctly.
4. Hit `mod+r` → page reloads, loading bar animates.
5. Run a `bun dev` script in terminal printing `http://localhost:5173`, link in xterm → context menu offers "Open in preview".
6. Restart server (kill `apps/server` child, watch it respawn) → preview tab survives, server replays `opened` event on reconnect, panel state matches reality.
7. Switch threads → previous thread's preview tab is closed (v1); new thread shows empty state.
8. Open a second window of the desktop (if supported) or open the same server from a browser tab in another window → `preview.list(threadId)` returns the snapshot, panel is empty in browser (correct: not desktop).

---

## 12. Risks and resolutions

| Risk                                                                                                             | Resolution                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden `<webview>` GPU cost when keeping multiple threads' previews mounted                                      | v1 only mounts the active thread's preview. v2 can adopt the `PersistentThreadTerminalDrawer` pattern + `setVisibility`                                                                                                                  |
| `<webview>` keyboard capture eats `mod+shift+j` etc.                                                             | `before-input-event` forwarder in `PreviewViewManager` (mirror of ami's pattern, smaller shortcut list)                                                                                                                                  |
| URL with `X-Frame-Options: DENY` works fine in `<webview>` (good — that's why we picked `<webview>` over iframe) | n/a                                                                                                                                                                                                                                      |
| Server restart while desktop is alive: `<webview>` is still loaded but server has no record                      | On WS reconnect, web side sends a `preview.list(threadId)` and if empty, sends a `preview.open(...)` to re‑register the current URL. Add a small `useReconciliation` effect in `PreviewView.tsx`                                         |
| Renderer process renders something into `<webview>` but never registered → orphaned tab in `PreviewViewManager`  | `closeTab` is idempotent; on `<webview>` unmount, `unregisterWebview` is called; if that didn't fire (crash), the next `createTab` for the same `tabId` reuses the record                                                                |
| `autoOpenPreview` racing with terminal output (URL might not be in stdout yet by the time the script "starts")   | Two‑phase: if `script.previewUrl` is set, open eagerly with that URL. If not set but `autoOpenPreview === true`, watch terminal output via existing `terminal-links` extraction and open the first `previewable` URL within a 60s window |
| Multiple windows of the desktop both rendering the same `<webview>` for the same thread                          | `<webview>` is per‑renderer; each window creates its own. The shared `persist:t3code-preview` partition keeps cookies in sync. Server records the last navigation URL but doesn't enforce single‑renderer                                |

---

## 13. Out of scope (v2+)

Explicitly **not** in this landing:

- Devtools support (would need to port ami's `WebContentsView` + `setDevToolsWebContents` + bounds sync — significant)
- Page screenshot capture
- JavaScript injection / `executeJavaScript`
- React Grab / element picker
- Console log capture
- Playwright/CDP agent automation tools (`browser_snapshot`, `browser_execute`)
- System cookie import (Chrome/Safari decryption)
- Multi-tab per thread (groups/splits)
- Agent control overlay ("Agent" pill while controlled)
- Web build iframe fallback

Any of these can land in follow-up PRs against the same `PreviewViewManager` + `PreviewManager` shape — the v1 schemas are forward‑compatible (e.g. `tabId` is already there for multi‑tab; `recentEvents` ring buffer is already there for console/screenshot events).

---

## 14. UI design system — primitives we reuse

Every visible element below is built on existing components. No new design primitives are introduced. References below are to the `apps/web/src/components/ui/` directory.

| Need                                           | Primitive                                                                                                              | File ref                                        | Notes                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Theme colors / radii                           | CSS vars `--background`, `--card`, `--muted`, `--muted-foreground`, `--border`, `--input`, `--ring`, `--success`, etc. | `apps/web/src/index.css:86`                     | Light + `@variant dark` blocks. Always reference vars via tailwind utilities (`bg-card`, `text-muted-foreground`) — never hard‑code hex |
| `cn` class merger                              | `cn(...inputs)` from `~/lib/utils`                                                                                     | `apps/web/src/lib/utils.ts:8`                   | Wraps `cx` + `tailwind-merge`                                                                                                           |
| Buttons (chrome bar back/fwd/refresh)          | `Button` `variant="ghost"` `size="icon-xs"`                                                                            | `apps/web/src/components/ui/button.tsx`         | `icon-xs` is `size-7 rounded-md sm:size-6` — exactly the density in the screenshot                                                      |
| Buttons (URL field submit)                     | `Button` `variant="outline"` `size="sm"`                                                                               | same                                            | Matches the "ProjectScript primary action" density already in `BranchToolbar`                                                           |
| Button group (back / fwd / refresh as a unit)  | `Group` + implicit segmenting (no `GroupSeparator`)                                                                    | `apps/web/src/components/ui/group.tsx`          | Group automatically removes outer borders between adjacent `[data-slot]` children                                                       |
| URL input (chrome bar editable)                | `InputGroup` + `InputGroupInput` + `InputGroupAddon align="inline-start"` (globe icon)                                 | `apps/web/src/components/ui/input-group.tsx`    | Click‑anywhere‑to‑focus already wired in `InputGroupAddon`'s `onMouseDown`                                                              |
| URL input (chrome bar disabled / read‑only)    | Same `InputGroup` with `disabled` on the input                                                                         | same                                            | Yields the muted look in the screenshot via `has-[input:disabled]:opacity-64`                                                           |
| Tab strip cells                                | Plain `<button>` + `cn` — **not** `Tabs` (base‑ui Tabs is over‑featured for browser tabs); `Group` semantics differ    | new file `PreviewTabStrip.tsx`                  | Same hover/active treatment as the sidebar's `ChatPreview` rows                                                                         |
| "Local" recommendation card                    | `Card` (no `CardHeader`/`CardPanel` — flat)                                                                            | `apps/web/src/components/ui/card.tsx`           | `Card` already gives `rounded-2xl border bg-card text-card-foreground shadow-xs/5` plus the inset stroke via `before:`                  |
| Status pulse dot (running)                     | `<span>` with `bg-success` and `animate-pulse`                                                                         | tailwind built‑in                               | Theme‑aware via `--success`                                                                                                             |
| Tooltips (back/fwd/refresh hover)              | `Tooltip` + `TooltipTrigger` + `TooltipPopup`                                                                          | `apps/web/src/components/ui/tooltip.tsx`        | Sub‑200ms hover already configured                                                                                                      |
| Empty state title + description                | `Empty`, `EmptyHeader`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`, `EmptyMedia`                                 | `apps/web/src/components/ui/empty.tsx`          | `EmptyMedia variant="icon"` gives the stacked‑cards icon with side rotation we want for "no preview yet"                                |
| Loading bar (top of webview while navigating)  | Plain `<div>` with `bg-primary` + `transition-all`                                                                     | n/a                                             | Mirrors ami's loading bar (`browser-view.tsx:434`) — single‑pixel‑height div animating `width`                                          |
| Spinner (inline in URL field while loading)    | `Spinner`                                                                                                              | `apps/web/src/components/ui/spinner.tsx`        | Wraps `Loader2Icon` from lucide                                                                                                         |
| Context menu (terminal link "Open in preview") | `localApi.contextMenu.show(...)` (already exists)                                                                      | `apps/web/src/localApi.ts:58`                   | Native menu on desktop, fallback in `contextMenuFallback.ts` on web                                                                     |
| Keybinding shortcut label in tooltips          | `shortcutLabelForCommand(keybindings, "preview.toggle")`                                                               | `apps/web/src/keybindings.ts`                   | Renders `⌘⇧J` etc.                                                                                                                      |
| Right‑panel shell sizing                       | Match `DiffPanelShell` exactly: `w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border`                 | `apps/web/src/components/DiffPanelShell.tsx:32` | Single class string, do not reinvent                                                                                                    |

**Icons.** Use `lucide-react` everywhere (already in `package.json`). The exact icons we need:

```ts
import {
  ArrowLeft,
  ArrowRight, // back / forward
  RotateCw,
  Loader2, // refresh / spinning
  Globe, // favicon fallback
  X, // close tab
  Plus, // new tab
  Copy,
  ExternalLink, // open in browser, copy URL
  Sidebar,
  Columns2, // right‑side toggles in tab strip (matches screenshot 2)
  PanelRightOpen,
  PanelRightClose, // alt for above
} from "lucide-react";
```

`@hugeicons/react` is **not** a t3code dep — don't import it.

**Density.** The reference points are `BranchToolbar` (`apps/web/src/components/BranchToolbar.tsx`) for the chrome row density and `ChatPreview` (`apps/web/src/components/sidebar/chat-preview.tsx`) for the tab strip cell density. Match those, don't invent new heights.

---

## 15. Visual designs (matching the provided mockups)

Three states render inside `PreviewView.tsx` based on the `PreviewSession` for the active thread:

| Session state         | Component rendered                                                      |
| --------------------- | ----------------------------------------------------------------------- |
| no tab open           | `<PreviewEmptyState />` — disabled chrome row + "Local" recommendations |
| tab loading / loaded  | `<PreviewWebview />` + chrome row + tab strip                           |
| tab navigation failed | `<PreviewUnreachable />` overlay above the webview                      |

### 15.1 Empty state (`PreviewEmptyState.tsx`) — matches screenshot 1

The chrome row shows but **everything is disabled**: back, forward, refresh, and the URL field. Below, a "Local" section lists discovered listening localhost ports as cards. Clicking a card calls `EnvironmentApi.preview.open({ threadId, url })`.

Layout reference (annotated):

```
┌────────────────────────────────────────────────────────────────┐
│  ←   →   ↻      [ 🌐 (disabled URL field) ]                   │  ← chrome row, all controls disabled
├────────────────────────────────────────────────────────────────┤
│                                                                │
│                                                                │
│                                                                │
│   Local                                                        │  ← text-muted-foreground text-sm
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  ┌──────┐                                                │ │
│   │  │ ●●●  │  localhost:5175                          ●     │ │  ← Card row
│   │  │ ──   │  localhost:5175                                │ │      title text-sm font-medium text-foreground
│   │  │ ──   │                                                │ │      subtitle text-xs text-muted-foreground
│   │  └──────┘                                                │ │      green dot bg-success animate-pulse
│   └──────────────────────────────────────────────────────────┘ │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  ┌──────┐                                                │ │
│   │  │ ●●●  │  localhost:3000                          ●     │ │
│   │  │ ──   │  next-server                                   │ │
│   │  └──────┘                                                │ │
│   └──────────────────────────────────────────────────────────┘ │
│                                                                │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Skeleton (paste-able):

```tsx
// apps/web/src/components/preview/PreviewEmptyState.tsx
"use client";

import { useDiscoveredLocalServers } from "~/components/preview/useDiscoveredLocalServers";
import { Card } from "~/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";

interface Props {
  threadId: string;
  onOpen: (url: string) => void;
}

export function PreviewEmptyState({ threadId, onOpen }: Props) {
  const servers = useDiscoveredLocalServers(threadId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-6 pt-10 pb-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Local</h2>
      </div>

      {servers.length === 0 ? (
        <Empty>
          <EmptyTitle>No preview yet</EmptyTitle>
          <EmptyDescription>
            Run a dev script or paste a URL above to start previewing.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2 px-4 pb-6">
          {servers.map((s) => (
            <LocalServerCard key={s.url} server={s} onClick={() => onOpen(s.url)} />
          ))}
        </div>
      )}
    </div>
  );
}

function LocalServerCard({
  server,
  onClick,
}: {
  server: { url: string; host: string; port: number; processName: string | null };
  onClick: () => void;
}) {
  return (
    <Card
      render={
        <button
          type="button"
          onClick={onClick}
          className="group flex items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/50"
        />
      }
    >
      <BrowserMockup className="size-10 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {server.host}:{server.port}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {server.processName ?? `${server.host}:${server.port}`}
        </span>
      </div>
      <span className="size-2 shrink-0 rounded-full bg-success" aria-label="Listening">
        <span className="block size-2 rounded-full bg-success animate-ping opacity-60" />
      </span>
    </Card>
  );
}
```

The little browser thumbnail next to each card is a tiny tailwind-only mockup (matches the screenshot — three traffic-light dots over two muted lines):

```tsx
// apps/web/src/components/preview/BrowserMockup.tsx
import { cn } from "~/lib/utils";

export function BrowserMockup({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex flex-col gap-1 rounded-md border border-border bg-card p-1.5 shadow-xs/5",
        className,
      )}
      aria-hidden
    >
      <div className="flex gap-0.5">
        <span className="size-1 rounded-full bg-red-400/80" />
        <span className="size-1 rounded-full bg-amber-400/80" />
        <span className="size-1 rounded-full bg-emerald-400/80" />
      </div>
      <div className="flex flex-1 flex-col gap-0.5 pt-0.5">
        <span className="h-0.5 w-full rounded-full bg-muted-foreground/30" />
        <span className="h-0.5 w-3/5 rounded-full bg-muted-foreground/20" />
      </div>
    </div>
  );
}
```

The chrome row in the empty state — note the `disabled` props on every interactive element:

```tsx
// inside PreviewView.tsx, when previewState.snapshot == null
<PreviewChromeRow
  canGoBack={false}
  canGoForward={false}
  canRefresh={false}
  loading={false}
  url=""
  onBack={NOOP}
  onForward={NOOP}
  onRefresh={NOOP}
  onSubmitUrl={(url) => api.preview.open({ threadId, url })}
  inputDisabled={false} // we still want to allow paste-to-open
  buttonsDisabled // back/fwd/refresh are visually disabled
/>
```

### 15.2 Tab strip (`PreviewTabStrip.tsx`) — matches screenshot 2

The tab strip is one row above the chrome row. Each tab shows favicon + title + close button. Right-aligned at the end: a "Toggle as side panel" button and a "Toggle sidebar" button.

```
┌────────────────────────────────────────────────────────────────┐
│ ┌─ 🌐 This site can't be re… ✕ ─┐                       ⤡  □  │  ← tab strip
├────────────────────────────────────────────────────────────────┤
│ ←   →   ↻     [URL bar]                                        │  ← chrome row
├────────────────────────────────────────────────────────────────┤
│                                                                │
│                       <webview content>                        │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

For v1 (single tab per thread) the strip renders exactly one tab. For v2 it grows. Either way we ship the strip now so the layout doesn't shift later.

```tsx
// apps/web/src/components/preview/PreviewTabStrip.tsx
"use client";

import { Globe, Plus, Sidebar, X } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { faviconUrlForOrigin } from "~/lib/favicon";

interface PreviewTabDescriptor {
  tabId: string;
  title: string;
  url: string | null;
  active: boolean;
}

interface Props {
  tabs: ReadonlyArray<PreviewTabDescriptor>;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  onToggleSidePanel: () => void;
  onToggleSidebar: () => void;
}

export function PreviewTabStrip({
  tabs,
  onActivate,
  onClose,
  onNewTab,
  onToggleSidePanel,
  onToggleSidebar,
}: Props) {
  return (
    <div className="flex h-9 items-center gap-1 border-b border-border bg-background px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <PreviewTab
            key={tab.tabId}
            tab={tab}
            onActivate={() => onActivate(tab.tabId)}
            onClose={() => onClose(tab.tabId)}
          />
        ))}
        <button
          type="button"
          aria-label="New preview tab"
          onClick={onNewTab}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Open in browser"
                onClick={onToggleSidePanel}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              />
            }
          >
            <ExternalLink className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Open in system browser</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Close panel"
                onClick={onToggleSidebar}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              />
            }
          >
            <Sidebar className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Close preview</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function PreviewTab({
  tab,
  onActivate,
  onClose,
}: {
  tab: PreviewTabDescriptor;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        tab.active
          ? "border-input bg-card text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <TabFavicon url={tab.url} />
        <span className="truncate">{tab.title}</span>
      </button>
      <button
        type="button"
        aria-label="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
      >
        <X className="size-2.5" />
      </button>
    </div>
  );
}
```

### 15.3 Favicon helper (`apps/web/src/lib/favicon.ts`)

Borrowed from ami's `custom-tab.tsx:57` — Google's s2 favicon endpoint with `onError` fallback to a `<Globe />` icon. Lives in its own module so we can swap providers later (e.g. self-hosted favicon proxy).

```ts
// apps/web/src/lib/favicon.ts
const FAVICON_PROVIDER = "https://www.google.com/s2/favicons";

export function faviconUrlForOrigin(rawUrl: string | null, size = 32): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.host) return null;
    return `${FAVICON_PROVIDER}?domain=${encodeURIComponent(url.host)}&sz=${size}`;
  } catch {
    return null;
  }
}
```

```tsx
// apps/web/src/components/preview/TabFavicon.tsx
import { Globe } from "lucide-react";
import { useEffect, useState } from "react";
import { faviconUrlForOrigin } from "~/lib/favicon";

export function TabFavicon({ url }: { url: string | null }) {
  const src = faviconUrlForOrigin(url, 32);
  const [errored, setErrored] = useState(false);
  useEffect(() => setErrored(false), [src]);

  if (!src || errored) {
    return <Globe className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return (
    <img
      src={src}
      alt=""
      className="size-3.5 shrink-0 rounded-sm"
      onError={() => setErrored(true)}
    />
  );
}
```

### 15.4 Unreachable / error state (`PreviewUnreachable.tsx`) — port of 404.html

When `navStatus._tag === "LoadFailed"`, render this instead of the failed `<webview>`. The original Chromium `404.html` (`asdasddddd.com` example) uses `--google-gray-*` vars; we map every Google gray to the closest theme variable so it auto-themes.

Color mapping (Chromium → t3code theme):

| Chromium                                                                      | Tailwind/t3code                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--background-color: #fff` / `--google-gray-900` (dark)                       | `bg-background`                                                                                                                                                                   |
| `--text-color: --google-gray-700` / `--google-gray-500` (dark)                | `text-muted-foreground`                                                                                                                                                           |
| `--heading-color: --google-gray-900` / `--google-gray-500` (dark)             | `text-foreground`                                                                                                                                                                 |
| `--error-code-color: --google-gray-700` / `--google-gray-500` (dark)          | `text-muted-foreground/70`                                                                                                                                                        |
| `--quiet-background-color: rgb(247,247,247)` / `--background` (dark)          | `bg-muted/40`                                                                                                                                                                     |
| `--primary-button-fill-color: --google-blue-600` / `--google-blue-300` (dark) | `bg-primary text-primary-foreground` (theme primary is `oklch(0.488 0.217 264)` light / `oklch(0.588 0.217 264)` dark — a very close blue)                                        |
| `--secondary-button-*`                                                        | `Button variant="outline"`                                                                                                                                                        |
| `--link-color: rgb(88,88,88)` / `--google-blue-300` (dark)                    | `text-primary underline-offset-4 hover:underline`                                                                                                                                 |
| Body font `system-ui, sans-serif; font-size: 75%`                             | We keep DM Sans (already in `apps/web/src/index.css:148`) and `text-sm` — the Chromium font tweak just compensates for their `html { font-size: 125% }` — we don't replicate that |

Skeleton:

```tsx
// apps/web/src/components/preview/PreviewUnreachable.tsx
"use client";

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface Props {
  url: string;
  errorCode: string; // e.g. "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION_REFUSED"
  description: string;
  onReload: () => void;
}

const ICON_GENERIC = (
  // Replace with an inline SVG that matches the Chromium "icon-generic"
  // (a stylized broken page). For v1 a Lucide MapPinOff is a fine stand-in —
  // we want a visual that reads "destination unreachable".
  <svg
    viewBox="0 0 64 64"
    className="size-10 text-muted-foreground/70"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
  >
    <path d="M16 12 L48 12 L48 52 L16 52 Z" />
    <path d="M22 22 L42 22 M22 30 L36 30 M22 38 L40 38" strokeLinecap="round" />
    <path d="M52 8 L12 56" strokeLinecap="round" />
  </svg>
);

export function PreviewUnreachable({ url, errorCode, description, onReload }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const host = safeHost(url) ?? url;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-6 py-12">
        {/* Icon + headline */}
        <div className="mb-6 flex flex-col gap-4">
          {ICON_GENERIC}
          <h1 className="text-2xl font-semibold leading-tight text-foreground">
            This site can&rsquo;t be reached
          </h1>
        </div>

        {/* Summary — uses dangerouslySetInnerHTML only for the bold host treatment */}
        <p className="text-sm leading-relaxed text-muted-foreground">
          <strong className="font-semibold text-foreground">{host}</strong>
          &rsquo;s server{" "}
          <abbr
            title="Domain Name System"
            className="cursor-help underline decoration-dotted underline-offset-2"
          >
            DNS address
          </abbr>{" "}
          could not be found.
        </p>

        {/* Suggestions list (when details open) */}
        {showDetails && (
          <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4 text-sm">
            <p className="mb-2 font-medium text-foreground">Try:</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Checking the connection</li>
              <li>Checking the proxy and the firewall</li>
              <li>Running Network Diagnostics</li>
            </ul>
          </div>
        )}

        {/* Error code */}
        <div className="mt-8 text-xs uppercase tracking-wide text-muted-foreground/70">
          {errorCode}
        </div>

        {/* Actions */}
        <div className="mt-auto flex items-center gap-2 pt-8">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? "Hide details" : "Details"}
          </Button>
          <div className="flex-1" />
          <Button type="button" size="sm" onClick={onReload}>
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
```

The component intentionally:

- Uses theme tokens only — looks correct in light + dark with no extra wiring.
- Drops Chromium's "Diagnose connection" / "Portal sign-in" buttons (irrelevant in our shell).
- Drops the dinosaur game (RIP).
- Maps `errorCode` → human description in `PreviewView.tsx` via a small lookup (`ERR_CONNECTION_REFUSED` → "Connection refused", etc.) before rendering.

### 15.5 Loading bar

A 1.5px primary-colored bar that fills as the page loads, anchored to the bottom of the chrome row. Direct port of ami's pattern (`browser-view.tsx:434`):

```tsx
{
  loadProgress > 0 && (
    <div
      className="pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 rounded-full bg-primary transition-all duration-150 ease-out"
      style={{
        width: `${loadProgress}%`,
        boxShadow: "0 0 6px 1px var(--ring)",
      }}
    />
  );
}
```

Progress is computed locally with `useLoadingProgress(isLoading)` — same hook signature as ami's, ~30 lines.

---

## 16. Local server discovery (port scanner)

The "Local" recommendations in §15.1 need a feed. New backend service.

### `apps/server/src/preview/Services/PortScanner.ts`

```ts
import { Context, Effect } from "effect";

export interface DiscoveredLocalServer {
  host: string; // "localhost"
  port: number; // 5175
  url: string; // "http://localhost:5175"
  processName: string | null; // "node", "vite", "next-server"
  pid: number | null;
}

export interface PreviewPortScannerShape {
  /** One-shot snapshot of currently listening localhost ports. */
  readonly scan: () => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
  /** Subscribe to changes. Listener is called on every diff. */
  readonly subscribe: (
    listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
  /** Hint that at least one client is interested → starts polling. Returns release fn. */
  readonly retain: () => Effect.Effect<() => void>;
}

export class PreviewPortScanner extends Context.Service<
  PreviewPortScanner,
  PreviewPortScannerShape
>()("t3/preview/Services/PortScanner") {}
```

### `apps/server/src/preview/Layers/PortScanner.ts`

Two strategies, picked at startup:

1. **Preferred — `lsof`** on macOS/Linux: `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` returns `pid`, `command`, `name` (host:port). Fast (<50ms typical), gives process name for free. Parsed via the `-F` field-format which is stable across versions.
2. **Fallback — TCP connect probe**: iterate a curated list of common dev ports `[3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000]` against `127.0.0.1`, mark any that accepts a connection. Used on Windows and as the safety net if `lsof` is missing.

Polling cadence:

- When `retain()` count is 0 → not polling.
- When ≥1 → poll every 3s. Diff against last result; only emit `subscribe` callbacks when the set differs.
- `retain()` returns a release fn that decrements the counter; goes idle automatically when the empty state is hidden.

The renderer side (`useDiscoveredLocalServers(threadId)`) calls `EnvironmentApi.preview.subscribePorts(callback)` and the WS handler calls `retain()` on first subscribe / releases on the last unsubscribe.

### Augmenting the discovery feed

The card list in §15.1 is the union of:

1. **Listening ports** from the scanner (above).
2. **Recently seen URLs** — `apps/web/src/previewStateStore.ts` already has a `recentEvents` ring buffer; we additionally maintain a small per-thread `recentUrlsFromTerminal: string[]` populated from the existing `terminal-links` extraction (already wired in `ThreadTerminalDrawer.tsx:454`).
3. **Configured URLs** — every active `ProjectScript.previewUrl` from the active project.

Deduped by URL string. Sort: configured > listening > recent. This yields the "smart, contextual, no-thought-required" feel the screenshot implies.

---

## 17. File map (additions to §3)

Append these to the file list:

| File                                                           | Purpose                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/preview/Services/PortScanner.ts`              | Service tag + interface                                                                                                          |
| `apps/server/src/preview/Layers/PortScanner.ts`                | `lsof` strategy + TCP probe fallback + polling                                                                                   |
| `apps/server/src/preview/Layers/PortScanner.test.ts`           | Parser tests for `lsof -F pcn` output                                                                                            |
| `apps/web/src/lib/favicon.ts`                                  | `faviconUrlForOrigin(url, size)` helper                                                                                          |
| `apps/web/src/components/preview/PreviewTabStrip.tsx`          | Tab strip (screenshot 2)                                                                                                         |
| `apps/web/src/components/preview/TabFavicon.tsx`               | Favicon `<img>` w/ `<Globe>` fallback                                                                                            |
| `apps/web/src/components/preview/BrowserMockup.tsx`            | Tiny tailwind browser thumbnail icon                                                                                             |
| `apps/web/src/components/preview/PreviewLocalServerCard.tsx`   | Card row for a discovered server                                                                                                 |
| `apps/web/src/components/preview/PreviewUnreachable.tsx`       | 404.html rewritten in tailwind                                                                                                   |
| `apps/web/src/components/preview/useDiscoveredLocalServers.ts` | Hook subscribing to `EnvironmentApi.preview.subscribePorts` + merging in `recentUrlsFromTerminal` and `ProjectScript.previewUrl` |
| `apps/web/src/components/preview/useLoadingProgress.ts`        | 30-line progress simulator (port of ami's)                                                                                       |
| `apps/web/src/components/preview/errorCodeMessages.ts`         | `ERR_*` → human-readable description map                                                                                         |

Update the contract additions in §4 to add:

```ts
// packages/contracts/src/preview.ts
export const DiscoveredLocalServer = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65536)),
  url: TrimmedNonEmptyString,
  processName: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type DiscoveredLocalServer = typeof DiscoveredLocalServer.Type;
```

WS routes added (§5):

```
preview.subscribePorts(callback) → unsubscribe
preview.scanPortsOnce()          → ReadonlyArray<DiscoveredLocalServer>
```

---

## 18. Implementation order (single‑shot landing) — REVISED

To minimize cross‑file thrash while writing:

1. `packages/contracts/src/preview.ts` (+ test) — `PreviewSession`, `PreviewEvent`, `DiscoveredLocalServer` schemas; `keybindings.ts` / `project.ts` schema edits → **build contracts first**.
2. `apps/server/src/preview/{Services,Layers}/Manager.ts` (+ test) and `{Services,Layers}/PortScanner.ts` (+ test).
3. `apps/server/src/ws.ts` and `runtimeLayer` provision (`PreviewManager.Default`, `PreviewPortScanner.Default`).
4. `apps/desktop/src/preview-view-manager.ts`, `preview-preload.ts`, `main.ts` IPC handlers, `preload.ts` `desktopBridge.preview` namespace; update `apps/desktop/tsdown.config.ts` to also bundle `preview-preload.ts` → `preview-preload.cjs`.
5. `apps/web/src/lib/favicon.ts`; `apps/web/src/previewStateStore.ts`, `apps/web/src/rightPanelStore.ts` (+ tests).
6. `apps/web/src/environmentApi.ts` — add `preview` slot.
7. Right‑panel arbiter migration in `ChatView.tsx` (replace `planSidebarOpen`, render preview alongside diff/plan).
8. Components, in dependency order:
   - `BrowserMockup.tsx`, `TabFavicon.tsx`, `useLoadingProgress.ts`, `errorCodeMessages.ts`, `useDiscoveredLocalServers.ts`
   - `PreviewLocalServerCard.tsx`, `PreviewEmptyState.tsx`
   - `PreviewUnreachable.tsx`
   - `PreviewTabStrip.tsx`
   - `PreviewWebview.tsx` (the `<webview>` host, no-op on web)
   - `PreviewView.tsx` (ties it all together: tab strip + chrome row + body switching between empty / webview / unreachable)
   - `PreviewPanelShell.tsx`, `PreviewPanel.tsx`
9. Keybinding wiring: `_chat.tsx` `preview.toggle`/`preview.refresh`/`preview.focusUrl`; `keybindings.ts` shortcut helpers.
10. `ProjectScriptsControl.tsx` form additions (`previewUrl`, `autoOpenPreview`).
11. `ThreadTerminalDrawer.tsx` link‑activation update — context menu "Open in preview" / "Open in browser" for previewable URLs.
12. `KEYBINDINGS.md` doc update — add `preview.*` commands and `previewFocus` / `previewOpen` `when` keys.
13. Run `bun fmt && bun lint && bun typecheck && bun run test` — must all pass per `AGENTS.md`.
14. Manual smoke against the dev desktop (`bun run dev:desktop`).

Estimated diff size: ~3,500–4,500 lines added (mostly net‑new files), ~200 lines modified across `ChatView.tsx`, `ThreadTerminalDrawer.tsx`, `ProjectScriptsControl.tsx`, `_chat.tsx`, `main.ts`, `preload.ts`, `tsdown.config.ts`, `keybindings.ts`, `ws.ts`, `KEYBINDINGS.md`.
