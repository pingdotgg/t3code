import {
  defineExtension,
  requireApi,
  useBrowserSurfaceSlot,
  useRemoteBrowserFrames,
} from "@t3tools/extension-sdk/authoring";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import {
  browserFramesApi,
  browserLocalServersApi,
  browserSessionsApi,
  filePresentationApi,
  resourcesLeaseApi,
  uiKeybindingsApi,
  uiNotificationsApi,
  uiPanelsApi,
  uiThemeApi,
  type BrowserSession,
  type BrowserSessionReceipt,
  type BrowserSessionStreamValue,
  type BrowserSessionViewport,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useCallback, useEffect, useRef, useState } from "react";

import { mintWorkspaceFileUrl } from "./fileOpen.js";
import { BrowserFavicon } from "./favicon.js";
import {
  type BrowserHistoryEntry,
  fitHistoryToSaveBudget,
  recentHistoryEntries,
  recordHistoryVisit,
  removeHistoryUrl,
  restoreTarget,
  sanitizeHistoryEntries,
} from "./historyStore.js";
import { LocalServersSection, NoPreview, RecentlyUsedHeading, useLocalServers } from "./landing.js";
import { landingModel } from "./localServers.js";
import { BrowserViewportToolbar, ViewportDeviceFrame, useElementSize } from "./viewportToolbar.js";
import {
  FALLBACK_RESPONSIVE_VIEWPORT_SIZE,
  createViewportCommitter,
  notifyViewportResizeFailure,
  responsiveViewportForToggle,
  viewportFailureMessage,
  type ViewportCommitter,
} from "./viewport.js";
import {
  BROWSER_GLOBAL_COMMANDS,
  BROWSER_VIEW_COMMANDS,
  focusAddressInput,
  notifyToggleFailure,
  togglePanelSurface,
  watchThemeVars,
} from "./uiContracts.js";
import {
  canGoBack,
  canGoForward,
  currentUrl,
  describeStatus,
  goBack,
  goForward,
  initialNavigationState,
  isLeaseUrl,
  recentTargets,
  reload,
  submitAddress,
  tabLabel,
  type NavigationState,
} from "./viewModel.js";

const manifestId = "t3.browser";

// Every theme-backed value chains a `--t3-browser-*` hop (published on the
// view root from `t3.ui/theme` tokens) ahead of the legacy host vars. When
// the contract is unavailable the hop never resolves and the legacy chain
// renders — the honest degraded path.
const muted = "var(--t3-browser-muted-foreground, var(--muted-foreground, #667085))";
const border = "1px solid var(--t3-browser-border, var(--border, #dfe3e8))";
const buttonStyle = {
  font: "inherit",
  fontSize: 12,
  padding: "2px 8px",
  border,
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
} as const;

/**
 * `t3.ui/theme` consumer. `getTokens` resolves the host's *effective* theme —
 * the provider's projection already folds the stored preference, live session
 * overlays, and external previews into the painted state — and each
 * `subscribeState` frame re-reads the tokens, so the panel tracks exactly
 * what the host paints without interpreting overlay semantics itself. The map
 * lands on the view root as `--t3-browser-*` custom properties; the contract
 * lifecycle lives in `watchThemeVars`, which clears the map on a failed read
 * or a closed/lost subscription so an obsolete palette never poses as
 * current — every style then falls back to its legacy `var()` chain.
 */
function useThemeVars(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
): Record<string, string> | null {
  const [vars, setVars] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    watchThemeVars(
      bindApi(uiThemeApi, host, session.context),
      bindStreamApi(uiThemeApi, host, session.context),
      AbortSignal.any([controller.signal, session.signal]),
      setVars,
    );
    return () => controller.abort();
  }, [host, session, visible]);
  return vars;
}

/**
 * `t3.ui/panels` behind the staged `toggle` command: dispatch supplies the
 * active thread's context (or the registration's own when no thread is
 * active — no thread means nothing to toggle). A failed hop toasts through
 * `t3.ui/notifications` when that grant exists, mirroring the native
 * `preview.toggle` "desktop-only" notice; without it the press is silent.
 */
function runGlobalBrowserCommand(
  host: ClientHost,
  call: { readonly commandId: string; readonly context: ViewContext },
): void {
  if (call.commandId !== "toggle") return;
  const threadId = call.context.resource.threadId;
  if (!threadId) return;
  void togglePanelSurface(
    bindApi(uiPanelsApi, host, call.context),
    threadId,
    AbortSignal.timeout(10_000),
  ).catch((error: unknown) => {
    void notifyToggleFailure(
      bindApi(uiNotificationsApi, host, call.context),
      threadId,
      error,
      AbortSignal.timeout(5_000),
    ).catch(() => {});
  });
}

/** Session identity held by this panel — tabId + serverEpoch fence the lease. */
interface HeldSession {
  readonly tabId: string;
  readonly serverEpoch: string;
  /** Latest engine-reported generation; commands fence on it. */
  readonly engineGeneration: string | null;
}

type PersistedViewState = {
  readonly relativePath?: string;
  readonly url?: string;
  readonly tabId?: string;
  readonly serverEpoch?: string;
  readonly history?: Json;
};

function restoreState(value: unknown): value is PersistedViewState | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => {
    if (key === "relativePath" || key === "url" || key === "tabId" || key === "serverEpoch")
      return typeof record[key] === "string";
    // Any malformed history container sanitizes to [] on read — the native
    // migrate step drops a bad list but keeps the browser usable, so the
    // container is never a reason to take the whole view unavailable.
    if (key === "history") return true;
    return false;
  });
}

/**
 * Browser panel on public contracts: chrome + navigation state are
 * panel-local (`viewModel.ts`); URL history persists through the bounded
 * `session.save` record (`historyStore.ts`); the page area is a
 * plugin-owned slot composited by the host through `t3.browser/surface`.
 * Session lifecycle is driven through `t3.browser/sessions` — `open`
 * creates the session the slot presents, `navigate`/commands carry the
 * epoch + engine-generation guards, and the events stream is the only
 * source of engine/navigation truth.
 */
function BrowserView(props: { host: ClientHost; session: ViewSession }) {
  const { host, session } = props;
  const restored = restoreState(session.restoreState) ? session.restoreState : null;
  const [state, setState] = useState<NavigationState>(() =>
    restored?.url ? submitAddress(initialNavigationState, restored.url) : initialNavigationState,
  );
  // Workspace file this view presents. Its lease URL expires,
  // so the path — never the minted URL — is what history and restore keep.
  const [fileSource, setFileSource] = useState<string | null>(
    restored?.url ? null : (restored?.relativePath ?? null),
  );
  const fileSourceRef = useRef(fileSource);
  const fileRun = useRef<AbortController | null>(null);
  const [address, setAddress] = useState<string>(restored?.url ?? restored?.relativePath ?? "");
  const [history, setHistory] = useState<readonly BrowserHistoryEntry[]>(() =>
    sanitizeHistoryEntries(restored?.history),
  );
  const [held, setHeld] = useState<HeldSession | null>(() =>
    restored?.tabId && restored?.serverEpoch
      ? {
          tabId: restored.tabId,
          serverEpoch: restored.serverEpoch,
          engineGeneration: null,
        }
      : null,
  );
  const [live, setLive] = useState<BrowserSession | null>(null);
  // Every session the thread holds — the tab strip renders the snapshot the
  // events stream already delivers; `tabsEpoch` is the serverEpoch that
  // snapshot arrived under (adoptions fence on it like every other command).
  const [tabs, setTabs] = useState<readonly BrowserSession[]>([]);
  const tabsEpoch = useRef<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [visible, setVisible] = useState(session.visible);
  const heldRef = useRef(held);
  const historyRef = useRef(history);
  const lastRevision = useRef(-1);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const contentSize = useElementSize(contentRef);
  const [viewportPending, setViewportPending] = useState(false);
  const viewportCommitter = useRef<ViewportCommitter | null>(null);
  const themeVars = useThemeVars(host, session, visible);
  const localServers = useLocalServers(host, session, visible && held === null);
  useEffect(() => {
    heldRef.current = held;
  }, [held]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => session.onVisibility(setVisible), [session]);

  // The events stream is authoritative: snapshot validates a restored or
  // adopted session, upserts carry engine/navigation truth, removal and close
  // reasons end the panel's hold honestly.
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      try {
        const api = bindStreamApi(browserSessionsApi, host, session.context);
        let pending: BrowserSession[] | null = null;
        for await (const frame of api.subscribe("events", {}, signal)) {
          signal.throwIfAborted();
          const value: BrowserSessionStreamValue | undefined = frame.value;
          if (!value) continue;
          const current = heldRef.current;
          switch (value.kind) {
            case "snapshot-start":
              pending = [];
              break;
            case "snapshot-chunk":
              pending?.push(...value.sessions);
              break;
            case "snapshot-complete": {
              tabsEpoch.current = value.serverEpoch;
              setTabs(pending ?? []);
              if (current) {
                const found = pending?.find((item) => item.tabId === current.tabId);
                if (value.serverEpoch !== current.serverEpoch || !found) {
                  heldRef.current = null;
                  setHeld(null);
                  setLive(null);
                  setFault(
                    value.serverEpoch !== current.serverEpoch
                      ? "Session ended (epoch-changed)"
                      : "Session ended (session-closed)",
                  );
                } else {
                  setLive(found);
                  lastRevision.current = value.revision;
                }
              }
              pending = null;
              break;
            }
            case "session-upsert":
              setTabs((currentTabs) => {
                const index = currentTabs.findIndex((item) => item.tabId === value.session.tabId);
                return index === -1
                  ? [...currentTabs, value.session]
                  : currentTabs.map((item, itemIndex) =>
                      itemIndex === index ? value.session : item,
                    );
              });
              if (current && value.session.tabId === current.tabId) {
                setLive(value.session);
                lastRevision.current = Math.max(lastRevision.current, value.revision);
                setHeld((previous) =>
                  previous
                    ? { ...previous, engineGeneration: value.session.engine.generation }
                    : previous,
                );
              }
              break;
            case "session-removed":
              setTabs((currentTabs) => currentTabs.filter((item) => item.tabId !== value.tabId));
              if (current && value.tabId === current.tabId) {
                heldRef.current = null;
                setHeld(null);
                setLive(null);
                setFault(`Session ended (session-closed: ${value.reason})`);
              }
              break;
            case "closed":
              if (current) {
                heldRef.current = null;
                setHeld(null);
                setLive(null);
              }
              tabsEpoch.current = null;
              setTabs([]);
              setFault(`Sessions stream closed (${value.reason})`);
              break;
          }
        }
      } catch (error) {
        if (!signal.aborted)
          setFault(error instanceof Error ? error.message : "Sessions stream unavailable");
      }
    })();
    return () => controller.abort();
  }, [host, session]);

  const {
    ref: surfaceSlotRef,
    lease: surfaceLease,
    denial: surfaceDenial,
  } = useBrowserSurfaceSlot(host, session, {
    session: held,
    visible: visible && held !== null,
    cornerRadius: 8,
  });

  /**
   * Remote-pixel fallback: hosts that cannot composite a native surface
   * (every non-Electron client) present the session's remote frame stream
   * inside the slot instead. `t3.browser/frames` mints lease-bound tickets;
   * pointer/wheel/keyboard input rides the lease-gated input lane — absent
   * grants simply produce no mints and the view stays present-only.
   */
  const remoteEligible =
    held !== null &&
    (host.browserSurface === undefined || host.browserSurface.presentation.supported === false);
  const remote = useRemoteBrowserFrames(host, session, {
    session: held,
    enabled: visible && remoteEligible && surfaceLease?.state.kind !== "ended",
  });

  /**
   * Row 11 — viewport sizing. Every resize rides `sessions.resize` through a
   * per-session commit queue (serialized, 15 s timeout, failures reported by
   * name); the queue outlives session upserts by reading the guard fields
   * from `heldRef` at dispatch time. Nothing applies optimistically: the
   * toolbar renders the session snapshot's viewport, so a rejected or timed-
   * out commit rolls the UI back by never leaving it.
   */
  useEffect(() => {
    const api = bindApi(browserSessionsApi, host, session.context);
    viewportCommitter.current = createViewportCommitter((viewport, signal) => {
      const current = heldRef.current;
      if (!current) return Promise.reject(new Error("No browser session to resize"));
      return api.invoke(
        "resize",
        {
          tabId: current.tabId,
          serverEpoch: current.serverEpoch,
          expectedEngineGeneration: current.engineGeneration,
          viewport,
        },
        signal,
      );
    });
    return () => {
      viewportCommitter.current = null;
    };
  }, [host, session]);

  const commitViewport = (next: BrowserSessionViewport) => {
    const committer = viewportCommitter.current;
    if (!committer) return;
    setViewportPending(true);
    void committer.commit(next, session.signal).then(
      (receipt) => {
        setViewportPending(false);
        // Stale receipts (older revision than already applied) never win.
        if (session.signal.aborted || receipt.revision < lastRevision.current) return;
        lastRevision.current = receipt.revision;
        if (receipt.outcome !== "accepted") {
          setFault(`Browser command ${receipt.outcome}`);
          return;
        }
        const heldNext = {
          tabId: receipt.session.tabId,
          serverEpoch: receipt.serverEpoch,
          engineGeneration: receipt.session.engine.generation,
        };
        heldRef.current = heldNext;
        setHeld(heldNext);
        setLive(receipt.session);
        setFault(null);
      },
      (error) => {
        setViewportPending(false);
        if (session.signal.aborted) return;
        // Native parity: the toast when `t3.ui/notify` is granted, the
        // inline fault line otherwise. The committed setting is untouched —
        // the rollback.
        const message = viewportFailureMessage(error);
        setFault(message);
        void notifyViewportResizeFailure(
          bindApi(uiNotificationsApi, host, session.context),
          session.context.resource.threadId ?? "",
          error,
          AbortSignal.timeout(5_000),
        ).catch(() => {});
      },
    );
  };

  /** Session-snapshot viewport — the only source the toolbar trusts. */
  const viewportSetting: BrowserSessionViewport | null = live?.viewport ?? null;
  const deviceMode = viewportSetting !== null && viewportSetting._tag !== "fill";

  /**
   * Persist the restore record: the url the view reopens on, the held
   * session identity, and the per-view history list.
   * fitHistoryToSaveBudget keeps the record under the SDK's bounded save
   * envelope by dropping the oldest entries.
   */
  const persist = (
    entries: readonly BrowserHistoryEntry[],
    url: string | null,
    heldSession: HeldSession | null,
  ) => {
    const base: {
      url?: string;
      relativePath?: string;
      tabId?: string;
      serverEpoch?: string;
    } = {
      ...restoreTarget(fileSourceRef.current, url),
      ...(heldSession ? { tabId: heldSession.tabId, serverEpoch: heldSession.serverEpoch } : {}),
    };
    session.save({ ...base, history: fitHistoryToSaveBudget(base, entries) });
  };

  /** Commit a navigation state; every landed target is a recorded visit. */
  const commit = (next: NavigationState) => {
    setState(next);
    if (next.status.kind !== "target" || isLeaseUrl(next.status.url)) return;
    const entries = recordHistoryVisit(history, next.status.url, Date.now());
    setHistory(entries);
    historyRef.current = entries;
    persist(entries, next.status.url, heldRef.current);
  };

  const removeRecent = (rawUrl: string) => {
    const entries = removeHistoryUrl(history, rawUrl);
    setHistory(entries);
    historyRef.current = entries;
    persist(entries, currentUrl(state), heldRef.current);
  };

  const dispatch = (run: (signal: AbortSignal) => Promise<BrowserSessionReceipt>) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void run(signal).then(
      (receipt) => {
        // Stale receipts (older revision than already applied) never win.
        if (signal.aborted || receipt.revision < lastRevision.current) return;
        lastRevision.current = receipt.revision;
        if (receipt.outcome !== "accepted") {
          setFault(`Browser command ${receipt.outcome}`);
          return;
        }
        const next = {
          tabId: receipt.session.tabId,
          serverEpoch: receipt.serverEpoch,
          engineGeneration: receipt.session.engine.generation,
        };
        heldRef.current = next;
        setHeld(next);
        setLive(receipt.session);
        setFault(null);
        const requested = receipt.session.requestedUrl;
        const base: { url?: string; relativePath?: string; tabId: string; serverEpoch: string } = {
          ...restoreTarget(fileSourceRef.current, requested),
          tabId: next.tabId,
          serverEpoch: next.serverEpoch,
        };
        session.save({ ...base, history: fitHistoryToSaveBudget(base, historyRef.current) });
      },
      (error) => {
        if (!signal.aborted)
          setFault(error instanceof Error ? error.message : "Browser command failed");
      },
    );
  };

  const presentFile = (relativePath: string | null) => {
    fileSourceRef.current = relativePath;
    setFileSource(relativePath);
  };

  const submit = (raw: string) => {
    fileRun.current?.abort();
    presentFile(null);
    const next = submitAddress(state, raw);
    commit(next);
    if (next.status.kind !== "target") return;
    go(next.status.url);
  };

  const go = (url: string) => {
    const api = bindApi(browserSessionsApi, host, session.context);
    // An ended lease means the held session is suspect — open fresh rather
    // than navigate a session the host already fenced off.
    const current = heldRef.current;
    const usable = current && surfaceLease?.state.kind !== "ended" ? current : null;
    dispatch((signal) =>
      usable
        ? api.invoke(
            "navigate",
            {
              tabId: usable.tabId,
              serverEpoch: usable.serverEpoch,
              url,
              expectedEngineGeneration: usable.engineGeneration,
            },
            signal,
          )
        : api.invoke("open", { url }, signal),
    );
  };

  /**
   * Present another session from the thread's snapshot in this panel. No
   * engine op: the held identity is plugin state, the slot re-leases onto
   * it, and the events stream validates the adoption exactly like a
   * restored session. Adopting is not a navigation — the address follows
   * the session, history records nothing — and a file-backed lease page
   * keeps its path so Reload can re-mint; any other tab drops the binding.
   */
  const adopt = useCallback(
    (tab: BrowserSession) => {
      const serverEpoch = tabsEpoch.current;
      if (!serverEpoch) return;
      fileRun.current?.abort();
      const next = { tabId: tab.tabId, serverEpoch, engineGeneration: tab.engine.generation };
      heldRef.current = next;
      setHeld(next);
      setLive(tab);
      setFault(null);
      const url = tab.navigation.url ?? tab.requestedUrl ?? null;
      if (url) {
        setAddress(url);
        setState((current) => submitAddress(current, url));
      }
      if (!(url && isLeaseUrl(url))) presentFile(null);
      const base: { url?: string; relativePath?: string; tabId: string; serverEpoch: string } = {
        ...restoreTarget(fileSourceRef.current, url),
        tabId: next.tabId,
        serverEpoch: next.serverEpoch,
      };
      session.save({ ...base, history: fitHistoryToSaveBudget(base, historyRef.current) });
    },
    [presentFile, session],
  );

  /**
   * Open a workspace file: mint a `workspace-file` lease, resolve it on this
   * document's origin, then open/navigate exactly like a typed address —
   * minus the history visit. Also the file view's Reload: a fresh mint
   * outlives the previous token's expiry.
   */
  const openFile = (relativePath: string) => {
    fileRun.current?.abort();
    const controller = new AbortController();
    fileRun.current = controller;
    const signal = AbortSignal.any([controller.signal, session.signal]);
    presentFile(relativePath);
    setAddress(relativePath);
    setFault(`Opening ${relativePath}…`);
    const lease = bindApi(resourcesLeaseApi, host, session.context);
    void mintWorkspaceFileUrl({
      lease: {
        getCapabilities: (abort) => lease.invoke("getCapabilities", {}, abort),
        createPresentationUrl: (resource, abort) =>
          lease.invoke("createPresentationUrl", { resource }, abort),
      },
      threadId: session.context.resource.threadId,
      relativePath,
      documentUrl: globalThis.location?.href,
      fetch: (url, init) => fetch(url, init),
      signal,
    }).then(
      (result) => {
        if (signal.aborted) return;
        if (!result.ok) {
          setFault(result.message);
          return;
        }
        setState((current) => submitAddress(current, result.url));
        go(result.url);
      },
      () => {},
    );
  };
  useEffect(() => {
    // A presentation open (or a restore whose session is gone) arrives as a
    // bare path: mint once on mount. A restored live session keeps its page.
    if (fileSourceRef.current && !heldRef.current) openFile(fileSourceRef.current);
    return () => fileRun.current?.abort();
    // Mount-only: later opens are explicit (Reload, a new presentation).
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, []);

  const command = (method: "back" | "forward" | "reload") => {
    if (method === "reload" && fileSourceRef.current) return openFile(fileSourceRef.current);
    if (!held) return;
    if (method === "back") commit(goBack(state));
    else if (method === "forward") commit(goForward(state));
    else commit(reload(state));
    const api = bindApi(browserSessionsApi, host, session.context);
    dispatch((signal) =>
      api.invoke(
        method,
        {
          tabId: held.tabId,
          serverEpoch: held.serverEpoch,
          expectedEngineGeneration: held.engineGeneration,
        },
        signal,
      ),
    );
  };

  // `t3.ui/keybindings` — view-local commands register under this view's own
  // thread context (a staged installation context can never deep-equal it)
  // and bind to this session, so arbitration's focused-view tier reaches the
  // handler. Registration is idempotent across sibling views on the same
  // context; a denied grant or absent seam leaves the chords unclaimed.
  const runViewCommand = useRef<(commandId: string) => void>(() => {});
  useEffect(() => {
    runViewCommand.current = (commandId) => {
      if (commandId === "reload") {
        if (held || fileSourceRef.current) command("reload");
        else commit(reload(state));
      } else if (commandId === "focusAddress") {
        focusAddressInput(addressRef.current);
      }
    };
  });
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(uiKeybindingsApi, host, session.context)
      .invoke("registerCommands", { commands: BROWSER_VIEW_COMMANDS }, signal)
      .then(
        ({ commandSetToken }) => {
          if (signal.aborted) return;
          try {
            session.bindCommands(commandSetToken, (call) => runViewCommand.current(call.commandId));
          } catch {
            // A stale token or a host without the binding seam leaves this
            // view without claimed shortcuts — the chords fall through.
          }
        },
        () => {},
      );
    return () => controller.abort();
  }, [host, session, visible]);

  const showRecents = state.status.kind !== "target" && recentHistoryEntries(history).length > 0;
  const landing = landingModel({
    recentCount: showRecents ? recentHistoryEntries(history).length : 0,
    localServers,
  });

  const leaseState = surfaceLease?.state;
  const remoteNotice =
    remote.status.kind === "connecting"
      ? "Connecting remote browser frames…"
      : remote.status.kind === "error"
        ? `Remote browser frames failed — ${remote.status.detail}`
        : remote.status.kind === "unsupported"
          ? `This client cannot composite a native browser surface and has no remote frame transport (${remote.status.detail}). The session is still open — view it from the desktop app.`
          : null;
  const surfaceNotice =
    leaseState?.kind === "ended"
      ? `Surface ended (${leaseState.reason}). Enter an address to open a new session.`
      : remoteEligible
        ? remoteNotice
        : surfaceDenial
          ? `Native presentation is unavailable — ${surfaceDenial.reason}${
              surfaceDenial.grant ? ` (missing grant: ${surfaceDenial.grant})` : ""
            }: ${surfaceDenial.detail}`
          : null;

  return (
    <section
      aria-label="Browser"
      data-t3-browser-panel
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        color: "var(--t3-browser-text, var(--foreground, #20252d))",
        background: "var(--t3-browser-canvas, var(--background, #fff))",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: 13,
        ...themeVars,
      }}
    >
      {/* Native focus treatment (cert browser-3): the host's 2px accent ring
          with a 1px canvas gap on focus-visible, matching the native address
          wrapper instead of the browser default 1px auto outline. */}
      <style>
        {`[data-t3-browser-panel] :is(button,input,select,textarea):focus-visible{outline:none;box-shadow:0 0 0 1px var(--t3-browser-canvas, var(--background, #fff)),0 0 0 3px var(--ring, var(--primary, #1b4ed8))}`}
      </style>
      <header
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderBottom: border,
          flexShrink: 0,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          aria-label="Back"
          disabled={held ? !(live?.canGoBack ?? false) : !canGoBack(state)}
          onClick={() => (held ? command("back") : commit(goBack(state)))}
          style={buttonStyle}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={held ? !(live?.canGoForward ?? false) : !canGoForward(state)}
          onClick={() => (held ? command("forward") : commit(goForward(state)))}
          style={buttonStyle}
        >
          →
        </button>
        <button
          type="button"
          aria-label="Reload"
          disabled={state.status.kind !== "target" && fileSource === null}
          onClick={() => (held || fileSource ? command("reload") : commit(reload(state)))}
          style={buttonStyle}
        >
          ⟳
        </button>
        <button
          type="button"
          aria-label={deviceMode ? "Turn off device toolbar" : "Turn on device toolbar"}
          aria-pressed={deviceMode}
          disabled={!held || viewportPending}
          onClick={() => {
            if (!viewportSetting) return;
            // Native toggle semantics: non-fill → fill; fill → a responsive
            // freeform sized from the panel this slot fills.
            commitViewport(
              viewportSetting._tag !== "fill"
                ? { _tag: "fill" }
                : responsiveViewportForToggle(contentSize),
            );
          }}
          style={{
            ...buttonStyle,
            ...(deviceMode
              ? { background: "var(--t3-browser-border, var(--border, #dfe3e8))" }
              : {}),
          }}
        >
          ⛶
        </button>
        <input
          type="text"
          aria-label="Address"
          placeholder="Search or enter address"
          ref={addressRef}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(address);
            if (event.key === "Escape") event.currentTarget.blur();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            font: "inherit",
            fontSize: 12,
            // The native address bar carries its ring on a rounded wrapper;
            // without a radius the focus ring would draw a hard rectangle.
            borderRadius: "var(--control-radius, 8px)",
            padding: "0 4px",
          }}
        />
      </header>
      {tabs.length > 0 && (
        <div
          role="tablist"
          aria-label="Open browser sessions"
          style={{
            display: "flex",
            gap: 4,
            padding: "0 8px 6px",
            overflowX: "auto",
            flexShrink: 0,
          }}
        >
          {tabs.map((tab) => {
            const tabUrl = tab.navigation.url ?? tab.requestedUrl ?? null;
            const active = held?.tabId === tab.tabId;
            return (
              <button
                key={tab.tabId}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (!active) adopt(tab);
                }}
                style={{
                  ...buttonStyle,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  maxWidth: 180,
                  whiteSpace: "nowrap",
                  ...(active
                    ? { background: "var(--t3-browser-border, var(--border, #dfe3e8))" }
                    : {}),
                }}
              >
                <BrowserFavicon url={tabUrl} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {tabLabel(tab.navigation.title, tabUrl)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div
        role="status"
        aria-label="Browser status"
        style={{ padding: "6px 10px", color: muted, fontSize: 11, flexShrink: 0 }}
      >
        {fault ??
          (held && live
            ? `${live.navigation.title || live.navigation.url || "session"} — engine ${live.engine.state}, navigation ${live.navigation.kind}`
            : describeStatus(state))}
      </div>
      {held ? (
        <div ref={contentRef} style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <div
            ref={surfaceSlotRef}
            aria-label="Browser surface"
            style={{ position: "absolute", inset: 0 }}
          />
          {remoteEligible && remote.status.kind !== "unsupported" && (
            <div
              ref={remote.ref}
              aria-label="Remote browser surface"
              style={{ position: "absolute", inset: 0 }}
            />
          )}
          {deviceMode && viewportSetting && (
            <>
              {/*
               * Slot sizing: the slot keeps presenting the whole content
               * area — the host's engine view lays the W × H frame out
               * inside it (toolbar strip, rails, centered, scaled down to
               * fit) exactly as it does for the native panel's own slot.
               * The overlays paint from the mirrored math so the visible
               * frame, the fit percentage, and the composited page coincide.
               * The toolbar covers the strip the engine view reserves, so
               * plugin chrome and engine chrome never stack.
               */}
              <BrowserViewportToolbar
                setting={viewportSetting}
                pending={viewportPending}
                onCommit={commitViewport}
              />
              <ViewportDeviceFrame
                slot={contentSize}
                setting={viewportSetting}
                fallbackSlot={FALLBACK_RESPONSIVE_VIEWPORT_SIZE}
              />
            </>
          )}
          {surfaceNotice && (
            <p
              role="note"
              style={{
                position: "absolute",
                inset: 0,
                margin: 0,
                padding: 12,
                fontSize: 12,
                color: muted,
                background: "var(--t3-browser-canvas, var(--background, #fff))",
              }}
            >
              {surfaceNotice}
            </p>
          )}
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: 12,
            display: "grid",
            gap: 10,
            alignContent: "start",
            justifyItems: "start",
          }}
        >
          {landing.noPreview && <NoPreview {...landing.noPreview} />}
          {showRecents && <RecentlyUsedHeading />}
          {showRecents && (
            <ul
              aria-label="Recently used"
              style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }}
            >
              {recentHistoryEntries(history).map((entry) => {
                const parsed = new URL(entry.url);
                const path = parsed.pathname === "/" ? "" : parsed.pathname;
                const label = `${parsed.host}${path}${parsed.search}${parsed.hash}`;
                return (
                  <li key={entry.url} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <BrowserFavicon url={entry.url} size={14} />
                    <button
                      type="button"
                      onClick={() => submit(entry.url)}
                      style={{
                        ...buttonStyle,
                        border: "none",
                        padding: "2px 0",
                        textAlign: "left",
                        textDecoration: "underline",
                        color: muted,
                      }}
                    >
                      {entry.title ? `${entry.title} — ${label}` : label}
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${label} from history`}
                      onClick={() => removeRecent(entry.url)}
                      style={{ ...buttonStyle, border: "none", padding: "0 2px", color: muted }}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <LocalServersSection
            servers={landing.serverList}
            notice={landing.localNotice}
            onOpen={(url) => {
              setAddress(url);
              submit(url);
            }}
          />
          {recentTargets(state).length > 0 && (
            <ul
              aria-label="Requested targets"
              style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }}
            >
              {recentTargets(state).map((target) => (
                <li key={target.url}>
                  <button
                    type="button"
                    aria-current={target.index === state.index}
                    onClick={() => submit(target.url)}
                    style={{
                      ...buttonStyle,
                      border: "none",
                      padding: "2px 0",
                      textAlign: "left",
                      textDecoration: "underline",
                      color:
                        target.index === state.index
                          ? "var(--t3-browser-text, var(--foreground, #20252d))"
                          : muted,
                    }}
                  >
                    {target.url}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

const authored = defineExtension({
  id: manifestId,
  version: "0.1.0",
  provides: [filePresentationApi.definition],
  serverEntry: "server.ts",
  requires: [
    requireApi(browserSessionsApi),
    requireApi(browserLocalServersApi),
    requireApi(browserFramesApi),
    requireApi(resourcesLeaseApi),
    requireApi(uiThemeApi),
    requireApi(uiKeybindingsApi),
    requireApi(uiPanelsApi),
    requireApi(uiNotificationsApi),
  ],
  surfaces: [
    {
      name: "view",
      title: "Browser",
      scope: "thread",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      // Stays empty: this field gates mounting on host services reached
      // through `session.invoke` — `t3.ui/*` are brokered APIs (bindApi,
      // opportunistic under grants) and `t3.browser/surface` rides
      // `host.browserSurface`, so no required service belongs here.
      capabilities: [],
      stateVersion: 1,
      validateRestore: restoreState,
      createView(host, session) {
        return { renderer: () => <BrowserView host={host} session={session} /> };
      },
    },
  ],
});

const client = authored.client;

export default {
  ...authored,
  ...(client === undefined
    ? {}
    : {
        client(host: ClientHost) {
          // Factory-time staging: only this path's `t3.extensions`-scoped
          // context makes `scope:"global"` + `activation` legal, and the host
          // flushes the set once a client-provider connection is live.
          host.registerGlobalCommands?.(BROWSER_GLOBAL_COMMANDS, (call) =>
            runGlobalBrowserCommand(host, call),
          );
          return client(host);
        },
      }),
};
