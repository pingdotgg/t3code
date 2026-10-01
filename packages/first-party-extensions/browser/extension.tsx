import {
  defineExtension,
  requireApi,
  Tooltip,
  useBrowserSurfaceSlot,
  useRemoteBrowserFrames,
} from "@t3tools/extension-sdk/authoring";
import {
  bindApi,
  bindStreamApi,
  describeGrantDenial,
  grantDenialMessage,
  resolveResumableStreams,
} from "@t3tools/extension-sdk/capabilities";
import {
  browserFramesApi,
  browserHistoryApi,
  browserLocalServersApi,
  browserProfilesApi,
  browserSessionsApi,
  composerContextApi,
  resourcesLeaseApi,
  uiExternalApi,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AddressInput, committedAddress } from "./addressInput.js";
import { resolveUiKit } from "@t3tools/extension-sdk/ui";
import { BrowserCaptureButtons } from "./annotateButton.js";
import { capturePageView } from "./capture.js";
import { mintWorkspaceFileUrl } from "./fileOpen.js";
import {
  BrowserFavicon,
  applySessionFavicons,
  resolveSessionFavicons,
  useFaviconCache,
} from "./favicon.js";
import { panelTabIndicators } from "./faviconStore.js";
import {
  adoptedFileSource,
  type BrowserHistoryEntry,
  fitHistoryToSaveBudget,
  recentHistoryEntries,
  recordHistoryVisit,
  removeHistoryUrl,
  restoreTarget,
  sanitizeHistoryEntries,
} from "./historyStore.js";
import { LocalServersSection, NoPreview, RecentlyUsedHeading, useLocalServers } from "./landing.js";
import {
  advanceRevision,
  createCommandDispatch,
  createProjectHistory,
  createRevisionFence,
  displayedHistory,
  isStaleRevision,
  titleUpdate,
  type ProjectHistoryState,
} from "./projectHistory.js";
import { landingModel } from "./localServers.js";
import {
  DEFAULT_ZOOM_FACTOR,
  engineStatusLabel,
  isRecoveryExhausted,
  nextZoomFactor,
  pageControlsBlock,
  awaitingEngineClaim,
  runPageCommand,
  type PageTarget,
  type PageVerb,
} from "./pageControls.js";
import { floatingLayers } from "./floating.js";
import { PageMenu, ZoomIndicator } from "./pageMenu.js";
import { MiniPlayerButton } from "./miniPlayer.js";
import { panelPopover, type PanelFloating } from "./popover.js";
import { bindProfilesApi, ProfileBadge, ProfileSection } from "./profileMenu.js";
import { createProfileListStore, profileFailureMessage, reopenRequest } from "./profiles.js";
import {
  BrowserViewportToolbar,
  ViewportDeviceFrame,
  ViewportResizeRails,
  useAspectLocks,
  useElementSize,
  useViewportRails,
} from "./viewportToolbar.js";
import {
  FALLBACK_RESPONSIVE_VIEWPORT_SIZE,
  ViewportTargetChangedError,
  createViewportCommitter,
  deviceViewportLayout,
  lockedAspectRatio,
  notifyViewportResizeFailure,
  responsiveViewportForToggle,
  viewportFailureMessage,
  type ViewportCommitter,
} from "./viewport.js";
import {
  BROWSER_GLOBAL_COMMANDS,
  BROWSER_VIEW_COMMANDS,
  externalOpenTarget,
  focusAddressInput,
  notifyToggleFailure,
  openExternally,
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
  isEpochChangedPresentation,
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

/** Native's disconnected wording, "<label> is not connected.", when the host knows the label. */
function disconnectedNotice(host: ClientHost): string {
  const label = host.environmentLabel?.();
  return label ? `${label} is not connected.` : "Environment is not connected.";
}

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
  const kit = resolveUiKit(props.host);
  const ChromeButton = kit?.Button ?? "button";
  const chromeProps = kit
    ? { variant: "ghost" as const, size: "icon-xs" as const }
    : { "data-t3-browser-fallback-control": "" };
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
  // The lease URL this view last minted for `fileSource`; adoption keeps the
  // path only for that page.
  const fileLeaseUrl = useRef<string | null>(null);
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
  // The status line's latest event: a fault, a capture run's progress or
  // result, or a profile action's result. Each replaces the last; null falls
  // back to the session line, so an older message never resurfaces.
  const [notice, setNotice] = useState<string | null>(null);
  const [visible, setVisible] = useState(session.visible);
  const [surfaceAttempt, setSurfaceAttempt] = useState(0);
  const surfaceUnavailableRef = useRef(false);
  const heldRef = useRef(held);
  const historyRef = useRef(history);
  const dropHeldSession = useCallback(() => {
    heldRef.current = null;
    setHeld(null);
    setLive(null);
    setNotice(null);
  }, [setHeld, setLive, setNotice]);
  // Every stream frame and command receipt applies only through this fence.
  const [fence] = useState(createRevisionFence);
  /**
   * Newest revision applied to the held tab's `live` session, reset when the
   * view adopts a tab. The stream is ordered, so upserts never go backwards
   * among themselves; only a receipt that overtook its own upsert leaves an
   * older upsert still to arrive, which must not roll `live` back.
   * `fence` cannot fence that: revisions are stream-wide, so another tab's
   * receipt would swallow this tab's updates.
   */
  const heldRevision = useRef(-1);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const contentSize = useElementSize(contentElement);
  const [viewportPending, setViewportPending] = useState(false);
  const viewportCommitter = useRef<ViewportCommitter | null>(null);
  const themeVars = useThemeVars(host, session, visible);
  const profilesApi = useMemo(() => bindProfilesApi(host, session.context), [host, session]);
  // One list per view for the badge and the page menu.
  const profiles = useMemo(
    () => createProfileListStore(profilesApi, session.signal),
    [profilesApi, session.signal],
  );
  const localServers = useLocalServers(host, session, visible && held === null);
  // Project-shared history (`t3.browser/history`); the view's own list stands
  // in until it arrives and whenever the contract cannot serve it.
  const [projectHistoryState, setProjectHistoryState] = useState<ProjectHistoryState>({
    kind: "loading",
  });
  const projectHistory = useMemo(
    () =>
      createProjectHistory(
        bindApi(browserHistoryApi, host, session.context),
        session.signal,
        setProjectHistoryState,
      ),
    [host, session],
  );
  // Other threads of the project record while this view is hidden: re-read on show.
  useEffect(() => {
    if (visible) projectHistory.refresh();
  }, [projectHistory, visible]);
  useEffect(() => {
    heldRef.current = held;
  }, [held]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => session.onVisibility(setVisible), [session]);

  // The events stream is authoritative: snapshot validates a restored or
  // adopted session, upserts carry engine/navigation truth, removal and close
  // reasons end the panel's hold honestly. A host that resumes it follows the
  // environment's connection like native's session sync: a drop suspends the
  // stream, and the next connection's snapshot reconciles the hold — ending
  // it when the server came back on a new epoch.
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const resumable = resolveResumableStreams(host, "t3.browser/sessions#events");
    let connected = false;
    const onSuspended = () => {
      if (signal.aborted || !connected) return;
      setNotice(disconnectedNotice(host));
    };
    void (async () => {
      try {
        const api = bindStreamApi(browserSessionsApi, host, session.context);
        let pending: BrowserSession[] | null = null;
        for await (const frame of api.subscribe(
          "events",
          {},
          signal,
          resumable ? { resume: "fresh-snapshot", onSuspended } : undefined,
        )) {
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
              // A receipt from the restarted server already moved past this epoch.
              if (fence.retired.has(value.serverEpoch)) {
                pending = null;
                break;
              }
              advanceRevision(fence, value.serverEpoch, value.revision);
              tabsEpoch.current = value.serverEpoch;
              setTabs(pending ?? []);
              if (connected) setNotice(null);
              connected = true;
              // A snapshot captured before the receipt that adopted the held
              // tab says nothing about it; the deltas queued behind it do.
              if (
                current &&
                !(
                  value.serverEpoch === current.serverEpoch && value.revision < heldRevision.current
                )
              ) {
                const found = pending?.find((item) => item.tabId === current.tabId);
                if (value.serverEpoch !== current.serverEpoch || !found) {
                  dropHeldSession();
                  // Like native's re-list, a restarted server's missing tab
                  // just drops back to the empty Browser.
                  if (value.serverEpoch === current.serverEpoch)
                    setNotice("Session ended (session-closed)");
                } else {
                  setLive(found);
                  heldRevision.current = value.revision;
                  if (surfaceUnavailableRef.current) setSurfaceAttempt((attempt) => attempt + 1);
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
              if (
                current &&
                value.session.tabId === current.tabId &&
                value.revision >= heldRevision.current
              ) {
                heldRevision.current = value.revision;
                setLive(value.session);
                if (tabsEpoch.current) advanceRevision(fence, tabsEpoch.current, value.revision);
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
                dropHeldSession();
                setNotice(`Session ended (session-closed: ${value.reason})`);
              }
              break;
            case "closed":
              if (current) {
                dropHeldSession();
              }
              tabsEpoch.current = null;
              setTabs([]);
              setNotice(`Sessions stream closed (${value.reason})`);
              break;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        // Without the sessions grant the panel cannot hold a page; say which
        // permission fixes it rather than the broker's raw text.
        const denial = describeGrantDenial(error);
        setNotice(
          denial
            ? `Browser sessions are unavailable — ${denial.message}`
            : error instanceof Error
              ? error.message
              : "Sessions stream unavailable",
        );
      }
    })();
    return () => controller.abort();
  }, [host, session]);

  // Captured favicons: each new ref the sessions carry is read once, when a
  // snapshot or upsert delivers it — no timer. Reads live as long as the view.
  // A landed read reaches this view's origins through the cache change.
  const faviconCache = useFaviconCache();
  useEffect(() => {
    resolveSessionFavicons(
      bindApi(browserSessionsApi, host, session.context),
      tabs,
      session.signal,
    );
  }, [host, session, tabs]);
  // Keyed on ref results, not the whole cache: applying writes only origin
  // captures, so it cannot re-trigger itself.
  const resolvedFaviconRefs = faviconCache.resolved;
  useEffect(() => applySessionFavicons(resolvedFaviconRefs, tabs), [resolvedFaviconRefs, tabs]);

  // The host renders this panel's tab icon and audio indicator from these.
  useEffect(() => {
    if (typeof session.setTabIndicators !== "function") return;
    const indicators = panelTabIndicators(faviconCache, live, tabs);
    try {
      session.setTabIndicators(indicators);
    } catch {
      // A capture the host refuses still leaves the page and audio chrome.
      const { faviconDataUrl: _refused, ...rest } = indicators ?? {};
      session.setTabIndicators(Object.keys(rest).length > 0 ? rest : null);
    }
  }, [session, faviconCache, live, tabs]);

  const {
    ref: surfaceSlotRef,
    lease: surfaceLease,
    denial: surfaceDenial,
    shown: surfaceShown,
    overlayZIndex,
  } = useBrowserSurfaceSlot(host, session, {
    session: held,
    visible: visible && held !== null,
    cornerRadius: 8,
  });
  useEffect(() => {
    surfaceUnavailableRef.current = surfaceDenial?.reason === "host-unavailable";
  }, [surfaceDenial?.reason]);
  const epochChangedPresentation =
    isEpochChangedPresentation(surfaceLease?.state ?? null) ||
    surfaceDenial?.reason === "epoch-changed";
  useEffect(() => {
    if (epochChangedPresentation) dropHeldSession();
  }, [epochChangedPresentation, dropHeldSession]);
  const layers = floatingLayers(overlayZIndex);
  const Popover = useMemo(() => panelPopover(host, layers.transient), [host, layers.transient]);
  const floating = useMemo<PanelFloating>(
    () => ({
      Popover,
      style: {
        color: "var(--t3-browser-text, var(--foreground, #20252d))",
        background: "var(--t3-browser-canvas, var(--background, #fff))",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: 13,
        ...themeVars,
      },
    }),
    [Popover, themeVars],
  );

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
    viewportCommitter.current = createViewportCommitter((viewport, signal, target) => {
      const current = heldRef.current;
      if (!current) return Promise.reject(new Error("No browser session to resize"));
      if (target !== undefined && current.tabId !== target) {
        return Promise.reject(new ViewportTargetChangedError());
      }
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

  /**
   * Settles (never rejects) once the resize has been applied or reported:
   * true when the server accepted it for the tab the view still holds.
   */
  const commitViewport = (next: BrowserSessionViewport, target?: string): Promise<boolean> => {
    const committer = viewportCommitter.current;
    if (!committer) return Promise.resolve(false);
    setViewportPending(true);
    return committer.commit(next, session.signal, target).then(
      (receipt) => {
        setViewportPending(false);
        // Stale receipts (older revision than already applied) never win,
        // and a receipt for a tab the view has since left or closed never
        // re-adopts it.
        if (session.signal.aborted) return false;
        // Superseded but accepted: the server applied it, so it still lands.
        if (isStaleRevision(fence, receipt.serverEpoch, receipt.revision))
          return receipt.outcome === "accepted";
        if (heldRef.current?.tabId !== receipt.session.tabId) return false;
        advanceRevision(fence, receipt.serverEpoch, receipt.revision);
        heldRevision.current = Math.max(heldRevision.current, receipt.revision);
        if (receipt.outcome !== "accepted") {
          setNotice(`Browser command ${receipt.outcome}`);
          return false;
        }
        const heldNext = {
          tabId: receipt.session.tabId,
          serverEpoch: receipt.serverEpoch,
          engineGeneration: receipt.session.engine.generation,
        };
        heldRef.current = heldNext;
        setHeld(heldNext);
        setLive(receipt.session);
        setNotice(null);
        return true;
      },
      (error) => {
        setViewportPending(false);
        // A rail edit left behind by a tab switch is dropped, not reported.
        if (session.signal.aborted || error instanceof ViewportTargetChangedError) return false;
        // Native parity: the toast when `t3.ui/notify` is granted, the
        // inline fault line otherwise. The committed setting is untouched —
        // the rollback.
        const message = viewportFailureMessage(error);
        setNotice(message);
        void notifyViewportResizeFailure(
          bindApi(uiNotificationsApi, host, session.context),
          session.context.resource.threadId ?? "",
          error,
          AbortSignal.timeout(5_000),
        ).catch(() => {});
        return false;
      },
    );
  };

  /** Session-snapshot viewport — the only committed source the chrome trusts. */
  const viewportSetting: BrowserSessionViewport | null = live?.viewport ?? null;
  const deviceMode = viewportSetting !== null && viewportSetting._tag !== "fill";
  const viewportSlot = contentSize ?? FALLBACK_RESPONSIVE_VIEWPORT_SIZE;
  const pageZoom = live?.zoomFactor ?? 1;
  const fixedViewport =
    viewportSetting !== null && viewportSetting._tag !== "fill" ? viewportSetting : null;
  const aspectLocks = useAspectLocks(tabs, held);
  const aspectLocked = aspectLocks.isLocked(held);
  const rails = useViewportRails({
    setting: fixedViewport,
    target: held?.tabId ?? null,
    slot: viewportSlot,
    zoomFactor: pageZoom,
    aspectRatio: lockedAspectRatio(fixedViewport, aspectLocked),
    commit: commitViewport,
  });
  /** Toolbar and toggle changes supersede any rail edit still pending, like native. */
  const commitViewportChange = (next: BrowserSessionViewport) => {
    rails.cancel();
    return commitViewport(next);
  };

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
    projectHistory.remove(rawUrl);
    const entries = removeHistoryUrl(history, rawUrl);
    setHistory(entries);
    historyRef.current = entries;
    persist(entries, currentUrl(state), heldRef.current);
  };

  const dispatch = createCommandDispatch<BrowserSessionReceipt>({
    signal: session.signal,
    fence,
    refuse: (outcome) => setNotice(`Browser command ${outcome}`),
    fail: (error) => {
      if (error instanceof Error && error.message.includes("BrowserStaleServerEpoch")) {
        if (held && heldRef.current?.serverEpoch === held.serverEpoch) dropHeldSession();
        return;
      }
      setNotice(error instanceof Error ? error.message : "Browser command failed");
    },
    adopt: (receipt) => {
      heldRevision.current = receipt.revision;
      const next = {
        tabId: receipt.session.tabId,
        serverEpoch: receipt.serverEpoch,
        engineGeneration: receipt.session.engine.generation,
      };
      heldRef.current = next;
      setHeld(next);
      setLive(receipt.session);
      setNotice(null);
      const requested = receipt.session.requestedUrl;
      const base: { url?: string; relativePath?: string; tabId: string; serverEpoch: string } = {
        ...restoreTarget(fileSourceRef.current, requested),
        tabId: next.tabId,
        serverEpoch: next.serverEpoch,
      };
      session.save({ ...base, history: fitHistoryToSaveBudget(base, historyRef.current) });
    },
  });

  const presentFile = (relativePath: string | null) => {
    if (relativePath !== fileSourceRef.current) fileLeaseUrl.current = null;
    fileSourceRef.current = relativePath;
    setFileSource(relativePath);
  };

  const submit = (raw: string) => {
    fileRun.current?.abort();
    presentFile(null);
    const next = submitAddress(state, raw);
    commit(next);
    if (next.status.kind !== "target") return;
    const url = next.status.url;
    // Native records an address the engine accepted into the project list;
    // workspace-file lease URLs never enter history.
    go(url, isLeaseUrl(url) ? undefined : () => projectHistory.record(url));
  };

  const go = (url: string, onAccepted?: () => void) => {
    if (surfaceDenial?.reason === "host-unavailable") setSurfaceAttempt((attempt) => attempt + 1);
    const api = bindApi(browserSessionsApi, host, session.context);
    // An ended lease means the held session is suspect, and a guest whose
    // recovery gave up stays dead — open fresh rather than navigate either.
    const current = heldRef.current;
    const usable =
      current && surfaceLease?.state.kind !== "ended" && !isRecoveryExhausted(live)
        ? current
        : null;
    // A page reopened after its session died keeps that session's profile.
    const reopen = usable ? null : reopenRequest(current ? live : null, url);
    dispatch(
      (signal) =>
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
          : reopen?.api === "profiles"
            ? profilesApi.invoke("open", reopen.input, signal).catch((error: unknown) => {
                throw new Error(profileFailureMessage("open", error));
              })
            : api.invoke("open", { url }, signal),
      onAccepted,
    );
  };

  /** Switching profile opens the current page in a new session under it (a profile is fixed at open). */
  const openInProfile = (profileId: string) => {
    const url = live?.navigation.url ?? live?.requestedUrl ?? undefined;
    setNotice(null);
    dispatch((signal) =>
      profilesApi
        .invoke("open", { profileId, ...(url === undefined ? {} : { url }) }, signal)
        .catch((error: unknown) => {
          throw new Error(profileFailureMessage("open", error));
        }),
    );
  };

  /**
   * Present another session from the thread's snapshot in this panel. No
   * engine op: the held identity is plugin state, the slot re-leases onto
   * it, and the events stream validates the adoption exactly like a
   * restored session. Adopting is not a navigation — the address follows
   * the session (blank when it has no URL), history records nothing — and
   * only the lease page this view minted keeps its path so Reload can
   * re-mint; any other tab drops the binding.
   */
  const adopt = useCallback(
    (tab: BrowserSession) => {
      const serverEpoch = tabsEpoch.current;
      if (!serverEpoch) return;
      fileRun.current?.abort();
      const next = { tabId: tab.tabId, serverEpoch, engineGeneration: tab.engine.generation };
      heldRef.current = next;
      heldRevision.current = -1;
      setHeld(next);
      setLive(tab);
      setNotice(null);
      const url = tab.navigation.url ?? tab.requestedUrl ?? null;
      setAddress(url ?? "");
      if (url) setState((current) => submitAddress(current, url));
      presentFile(adoptedFileSource(fileSourceRef.current, fileLeaseUrl.current, url));
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
    setNotice(`Opening ${relativePath}…`);
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
          setNotice(result.message);
          return;
        }
        fileLeaseUrl.current = result.url;
        setState((current) => submitAddress(current, result.url));
        go(result.url);
      },
      () => {},
    );
  };
  useEffect(() => {
    // A restored workspace path (or a restore whose session is gone) arrives
    // as a bare path: mint once on mount. A restored live session keeps its page.
    if (fileSourceRef.current && !heldRef.current) openFile(fileSourceRef.current);
    return () => fileRun.current?.abort();
    // Mount-only: later opens are explicit (Reload, the address bar).
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, []);

  /**
   * Engine verbs (back … closeDevTools) go to the host that owns the guest.
   * The stream stays the source of truth: an accepted receipt only refreshes
   * the held session early, and every refusal lands on the status line by
   * name. `tab` targets another session in the strip (its mute toggle)
   * without adopting it.
   */
  const leaseState = surfaceLease?.state;
  const engineClaimPending =
    host.browserSurface?.presentation.supported === true &&
    surfaceDenial === null &&
    (leaseState === undefined
      ? host.browserSurface.engineClaimPending === true
      : leaseState.kind === "active" &&
        leaseState.presentation.supported &&
        leaseState.engineClaimPending === true);
  const pendingZoom = useRef<number | null>(null);
  useEffect(() => {
    if (live?.zoomFactor === pendingZoom.current) pendingZoom.current = null;
  }, [live?.zoomFactor]);
  const runPage = (verb: PageVerb, tab?: BrowserSession) => {
    const epoch = tabsEpoch.current;
    const target: PageTarget | null = tab
      ? epoch
        ? { tabId: tab.tabId, serverEpoch: epoch, engineGeneration: tab.engine.generation }
        : null
      : heldRef.current;
    if (!target) return;
    const targetPage = tab ?? live;
    const claimPending = (!tab || tab.tabId === held?.tabId) && engineClaimPending;
    if (verb.method === "zoom" && !tab) pendingZoom.current = verb.zoomFactor;
    const api = bindApi(browserSessionsApi, host, session.context);
    void runPageCommand(api, target, targetPage, verb, session.signal, claimPending).then(
      (outcome) => {
        if (session.signal.aborted) return;
        if (outcome.kind !== "accepted") {
          if (verb.method === "zoom" && !tab) pendingZoom.current = null;
          if (
            outcome.kind !== "blocked" ||
            targetPage === null ||
            !awaitingEngineClaim(targetPage, claimPending)
          )
            setNotice(outcome.message);
          return;
        }
        setNotice(null);
        const { receipt } = outcome;
        const current = heldRef.current;
        if (!current || receipt.session.tabId !== current.tabId) return;
        if (!advanceRevision(fence, receipt.serverEpoch, receipt.revision)) return;
        heldRevision.current = Math.max(heldRevision.current, receipt.revision);
        const next = { ...current, engineGeneration: receipt.session.engine.generation };
        heldRef.current = next;
        setHeld(next);
        setLive(receipt.session);
      },
    );
  };

  /** One ladder step from the last requested factor, so quick presses compound. */
  const zoomStep = (direction: "in" | "out") =>
    runPage({
      method: "zoom",
      zoomFactor: nextZoomFactor(pendingZoom.current ?? live?.zoomFactor ?? null, direction),
    });

  const pageBlock = held ? pageControlsBlock(live, engineClaimPending) : null;

  const command = (method: "back" | "forward" | "reload") => {
    if (method === "reload" && fileSourceRef.current) return openFile(fileSourceRef.current);
    if (!held) return;
    if (method === "reload" && isRecoveryExhausted(live)) {
      // The dead guest cannot reload; its page reopens in a fresh session.
      const url = live?.navigation.url ?? live?.requestedUrl ?? null;
      if (url) go(url);
      return;
    }
    if (pageBlock !== null) {
      if (live === null || !awaitingEngineClaim(live, engineClaimPending)) setNotice(pageBlock);
      return;
    }
    if (method === "back") commit(goBack(state));
    else if (method === "forward") commit(goForward(state));
    else commit(reload(state));
    runPage({ method });
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
      } else if (held && (commandId === "zoomIn" || commandId === "zoomOut")) {
        zoomStep(commandId === "zoomIn" ? "in" : "out");
      } else if (held && commandId === "resetZoom") {
        runPage({ method: "zoom", zoomFactor: DEFAULT_ZOOM_FACTOR });
      }
    };
  });
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(uiKeybindingsApi, host, session.context, "^1.1.0")
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

  // Native enriches a recorded entry with the page title once it loads.
  const titled = titleUpdate(live?.navigation ?? null, fileSource !== null, isLeaseUrl);
  const titledUrl = titled?.url ?? null;
  const titledTitle = titled?.title ?? null;
  const lastTitled = useRef<string | null>(null);
  useEffect(() => {
    if (titledUrl === null || titledTitle === null) return;
    if (projectHistoryState.kind !== "ready" || projectHistoryState.entries.length === 0) return;
    const key = `${titledUrl}\n${titledTitle}`;
    if (lastTitled.current === key) return;
    lastTitled.current = key;
    projectHistory.setTitle(titledUrl, titledTitle);
  }, [projectHistory, projectHistoryState, titledUrl, titledTitle]);

  const recents = recentHistoryEntries(displayedHistory(projectHistoryState, history));
  const showRecents = state.status.kind !== "target" && recents.length > 0;
  // Native "Open in system browser": the page the held session shows, else
  // the committed target.
  const externalTarget = externalOpenTarget(
    live ? (live.navigation.url ?? live.requestedUrl) : currentUrl(state),
    fileSource,
  );
  const landing = landingModel({
    recentCount: showRecents ? recents.length : 0,
    localServers,
  });

  const remoteNotice =
    remote.status.kind === "connecting"
      ? "Connecting remote browser frames…"
      : remote.status.kind === "error"
        ? `Remote browser frames failed — ${remote.status.detail}`
        : remote.status.kind === "unsupported"
          ? `This client cannot composite a native browser surface and has no remote frame transport (${remote.status.detail}). The session is still open — view it from the desktop app.`
          : null;
  // Native disables capture until the page is on screen here and while it failed to load.
  const capturePage = capturePageView(surfaceLease, surfaceShown, live?.navigation.kind);
  const pageLoading =
    held !== null && (live?.navigation.kind === "loading" || live?.navigation.kind === "pending");
  const ChromeToolbar = kit?.Toolbar ?? "header";
  const NavigationGroup = kit?.Toolbar ?? "div";
  const toggleDeviceToolbar = () => {
    if (!viewportSetting) return;
    void commitViewportChange(
      viewportSetting._tag !== "fill" ? { _tag: "fill" } : responsiveViewportForToggle(contentSize),
    );
  };
  const captureButtons = (
    <BrowserCaptureButtons
      kit={kit}
      host={host}
      session={session}
      held={held}
      page={capturePage}
      onStatus={setNotice}
      style={buttonStyle}
    />
  );
  const externalButton = (
    <Tooltip host={host} label="Open in system browser">
      <ChromeButton
        {...chromeProps}
        type="button"
        aria-label="Open in system browser"
        disabled={externalTarget === null}
        style={kit ? undefined : buttonStyle}
        onClick={() => {
          if (externalTarget === null) return;
          void openExternally(
            bindApi(uiExternalApi, host, session.context),
            externalTarget,
            session.signal,
          ).then((fault) => {
            if (fault !== null && !session.signal.aborted) setNotice(fault);
          });
        }}
      >
        {kit ? <kit.Icon name="external" /> : "↗"}
      </ChromeButton>
    </Tooltip>
  );
  const surfaceNotice =
    epochChangedPresentation || surfaceDenial?.reason === "host-unavailable"
      ? null
      : leaseState?.kind === "ended" && leaseState.reason !== "superseded"
        ? `Surface ended (${leaseState.reason}). Enter an address to open a new session.`
        : remoteEligible
          ? remoteNotice
          : surfaceDenial
            ? surfaceDenial.grant
              ? `Native presentation is unavailable — ${grantDenialMessage(surfaceDenial.grant)}`
              : `Native presentation is unavailable — ${surfaceDenial.reason}: ${surfaceDenial.detail}`
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
        {`[data-t3-browser-fallback-control]:focus-visible{outline:none;box-shadow:0 0 0 1px var(--t3-browser-canvas, var(--background, #fff)),0 0 0 3px var(--ring, var(--primary, #1b4ed8))}`}
      </style>
      <ChromeToolbar
        style={
          kit
            ? undefined
            : {
                display: "flex",
                gap: 6,
                padding: 8,
                borderBottom: border,
                flexShrink: 0,
                alignItems: "center",
              }
        }
      >
        <NavigationGroup
          {...(kit ? ({ variant: "group" } as const) : { style: { display: "contents" } })}
          role="group"
          aria-label="Navigation"
        >
          <Tooltip host={host} label="Back">
            <ChromeButton
              {...chromeProps}
              type="button"
              aria-label="Back"
              disabled={
                held ? pageBlock !== null || !(live?.canGoBack ?? false) : !canGoBack(state)
              }
              onClick={() => (held ? command("back") : commit(goBack(state)))}
              style={kit ? undefined : buttonStyle}
            >
              {kit ? <kit.Icon name="back" /> : "←"}
            </ChromeButton>
          </Tooltip>
          <Tooltip host={host} label="Forward">
            <ChromeButton
              {...chromeProps}
              type="button"
              aria-label="Forward"
              disabled={
                held ? pageBlock !== null || !(live?.canGoForward ?? false) : !canGoForward(state)
              }
              onClick={() => (held ? command("forward") : commit(goForward(state)))}
              style={kit ? undefined : buttonStyle}
            >
              {kit ? <kit.Icon name="forward" /> : "→"}
            </ChromeButton>
          </Tooltip>
          <Tooltip host={host} label={pageLoading ? "Loading…" : "Refresh"}>
            <ChromeButton
              {...chromeProps}
              type="button"
              aria-label={pageLoading ? "Stop" : "Refresh"}
              disabled={
                fileSource === null &&
                (held
                  ? pageBlock !== null && !isRecoveryExhausted(live)
                  : state.status.kind !== "target")
              }
              onClick={() => (held || fileSource ? command("reload") : commit(reload(state)))}
              style={kit ? undefined : buttonStyle}
            >
              {kit ? <kit.Icon name="refresh" refreshing={pageLoading} /> : "⟳"}
            </ChromeButton>
          </Tooltip>
        </NavigationGroup>
        {/* Native has no tooltip here; the action is More → Show/Hide device toolbar. */}
        {!kit && (
          <button
            data-t3-browser-fallback-control
            type="button"
            aria-label={deviceMode ? "Hide device toolbar" : "Show device toolbar"}
            aria-pressed={deviceMode}
            disabled={!held || viewportPending}
            onClick={toggleDeviceToolbar}
            style={{
              ...buttonStyle,
              ...(deviceMode
                ? { background: "var(--t3-browser-border, var(--border, #dfe3e8))" }
                : {}),
            }}
          >
            ⛶
          </button>
        )}
        {!kit && captureButtons}
        {held && live && (
          <ProfileBadge host={host} session={live} profiles={profiles} visible={visible} />
        )}
        <AddressInput
          kit={kit}
          addon={externalButton}
          host={host}
          inputRef={addressRef}
          value={address}
          committed={committedAddress({
            fileSource,
            pageUrl: live ? (live.navigation.url ?? live.requestedUrl ?? null) : null,
            target: currentUrl(state),
          })}
          onValueChange={setAddress}
          onSubmit={submit}
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
        {kit ? captureButtons : externalButton}

        <MiniPlayerButton
          host={host}
          session={session}
          held={held}
          visible={visible}
          available={
            surfaceLease?.state.kind === "active" &&
            live?.engine.state === "ready" &&
            live?.navigation.kind !== "failed"
          }
          style={buttonStyle}
          report={setNotice}
        />
        <PageMenu
          kit={kit}
          host={host}
          session={held ? live : null}
          blockReason={pageBlock}
          run={(verb) => runPage(verb)}
          zoomStep={zoomStep}
          deviceMode={deviceMode}
          deviceDisabled={!held || viewportPending}
          onToggleDeviceToolbar={toggleDeviceToolbar}
          floating={floating}
          visible={visible}
        >
          {(close) =>
            held &&
            live && (
              <ProfileSection
                kit={kit}
                host={host}
                session={live}
                api={profilesApi}
                profiles={profiles}
                signal={session.signal}
                onOpenInProfile={openInProfile}
                report={setNotice}
                onChosen={close}
              />
            )
          }
        </PageMenu>
      </ChromeToolbar>
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
            const label = tabLabel(tab.navigation.title, tabUrl);
            return (
              <span
                key={tab.tabId}
                role="presentation"
                style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
              >
                <button
                  data-t3-browser-fallback-control
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
                  <BrowserFavicon url={tabUrl} faviconRef={tab.faviconRef} />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {label}
                  </span>
                </button>
                {/* Native parity: the speaker shows only while the page plays
                  audio, and reflects the engine-reported mute state. */}
                {tab.audible === true && (
                  <button
                    data-t3-browser-fallback-control
                    type="button"
                    aria-label={tab.audioMuted ? `Unmute ${label}` : `Mute ${label}`}
                    aria-pressed={tab.audioMuted === true}
                    disabled={
                      pageControlsBlock(tab, tab.tabId === held?.tabId && engineClaimPending) !==
                      null
                    }
                    onClick={() =>
                      runPage({ method: "setAudioMuted", muted: !tab.audioMuted }, tab)
                    }
                    style={{ ...buttonStyle, border: "none", padding: "0 2px" }}
                  >
                    {tab.audioMuted ? "🔇" : "🔊"}
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      <div
        role="status"
        aria-label="Browser status"
        style={{ padding: "6px 10px", color: muted, fontSize: 11, flexShrink: 0 }}
      >
        {notice ??
          (held && live
            ? `${live.navigation.title || live.navigation.url || "session"} — ${engineStatusLabel(live, engineClaimPending)}`
            : describeStatus(state))}
      </div>
      {held ? (
        <div ref={setContentElement} style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <div
            key={surfaceAttempt}
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
          <ZoomIndicator
            key={held.tabId}
            zoomFactor={live?.zoomFactor ?? null}
            zIndex={layers.transient}
            style={floating.style}
            visible={visible}
          />
          {rails.displayed && (
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
                host={host}
                setting={rails.displayed}
                pending={viewportPending}
                onCommit={commitViewportChange}
                aspectLocked={aspectLocked}
                onAspectLockedChange={(locked) => aspectLocks.setLocked(held, locked)}
                zIndex={layers.deviceChrome}
              />
              <ViewportDeviceFrame
                slot={contentSize}
                setting={rails.displayed}
                fallbackSlot={FALLBACK_RESPONSIVE_VIEWPORT_SIZE}
                zoomFactor={pageZoom}
                zIndex={layers.deviceChrome}
              />
              <ViewportResizeRails
                layout={deviceViewportLayout(viewportSlot, rails.displayed, pageZoom)}
                preview={rails.preview}
                onPointerDown={rails.onPointerDown}
                onKeyDown={rails.onKeyDown}
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
              {recents.map((entry) => {
                const parsed = new URL(entry.url);
                const path = parsed.pathname === "/" ? "" : parsed.pathname;
                const label = `${parsed.host}${path}${parsed.search}${parsed.hash}`;
                return (
                  <li key={entry.url} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <BrowserFavicon url={entry.url} size={14} />
                    <button
                      data-t3-browser-fallback-control
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
                      data-t3-browser-fallback-control
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
          {projectHistoryState.kind === "unavailable" && (
            <p role="note" style={{ margin: 0, fontSize: 11, color: muted }}>
              {projectHistoryState.message}
            </p>
          )}
          {projectHistoryState.kind === "ready" && projectHistoryState.truncated && (
            <p role="note" style={{ margin: 0, fontSize: 11, color: muted }}>
              Project history truncated — showing the most recent entries that fit.
            </p>
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
                    data-t3-browser-fallback-control
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
  requires: [
    requireApi(browserSessionsApi),
    requireApi(browserProfilesApi),
    requireApi(browserLocalServersApi),
    requireApi(browserHistoryApi),
    requireApi(browserFramesApi),
    requireApi(resourcesLeaseApi),
    requireApi(uiThemeApi),
    // Explicit floor until the defineApi `baseline` option unifies these at merge.
    requireApi(uiKeybindingsApi, "^1.1.0"),
    requireApi(uiPanelsApi),
    requireApi(uiNotificationsApi),
    requireApi(composerContextApi),
    requireApi(uiExternalApi),
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
