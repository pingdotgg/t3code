import {
  composerContextApi,
  filePresentationApi,
  terminalControlApi,
  terminalOutputApi,
  terminalOutputEventsApi,
  terminalSessionsApi,
  uiKeybindingsApi,
  uiPanelsApi,
  uiThemeApi,
  type TerminalOutputEventsValue,
  type TerminalSessionsListEvent,
} from "@t3tools/extension-sdk/catalogue";
import { defineExtension, requireApi } from "@t3tools/extension-sdk/authoring";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";

import { isMacPlatform } from "@t3tools/ghostty-terminal/platform";
import { isTerminalUrl } from "@t3tools/ghostty-terminal/terminal-links";
import { loadGhosttyRuntime, type GhosttyRuntime } from "@t3tools/ghostty-terminal/runtime";
import {
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "@t3tools/ghostty-terminal/surface";
import {
  isTerminalClearShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "./surfaceKeys.ts";
import { useTerminalSelectionMenu, type TerminalChatSink } from "./selectionMenu.tsx";
import { readAssetWithRetry, sharedLoad, type ReadAsset } from "./assetLoader.ts";
import { isBrokerStreamRefusal, TerminalStreamHub, type TerminalPaneLease } from "./streamHub.ts";
import { terminalFontFromVars, terminalThemeFromApp } from "./terminalTheme.ts";
import { TerminalVtAttachment, pumpTerminalOutput } from "./vtAttachment.ts";
import {
  EMPTY_OUTPUT_BUFFER,
  EMPTY_OVERFLOW_STREAK,
  MAX_TERMINALS_PER_GROUP,
  TERMINAL_GLOBAL_COMMANDS,
  TERMINAL_SURFACE_ID,
  TerminalPanel,
  applyOutputEvent,
  dispatchTerminalCommand,
  isResumableOutputClose,
  noteOutputFrameForStreak,
  plainTerminalText,
  registerPanelCommands,
  terminalChordAction,
  terminalPathLinkTarget,
  watchTerminalAppearanceVars,
  watchThemeVars,
  workspaceLaunchFromRevision,
  type OutputBuffer,
  type TerminalCommandActions,
  type TerminalControlOps,
  type TerminalPanelSnapshot,
} from "./viewModel.ts";

const manifestId = "t3.terminal";

/**
 * One hub per client document. Every mounted placement of this surface
 * shares it: the broker's 8-stream cap is per installation, so per-view
 * feeds would multiply against it — two visible placements with fixed feeds
 * of their own leave no room for even a first split.
 */
const streamHub = new TerminalStreamHub();

const GHOSTTY_VT_ASSET = "assets/ghostty-vt.wasm";
const GHOSTTY_WRITE_PTY_ASSET = "assets/ghostty-write-pty.wasm";
const SYMBOLS_FONT_ASSET = "assets/SymbolsNerdFontMono-Regular.woff2";

interface RestoredGroup {
  readonly id: string;
  readonly terminalIds: readonly string[];
  readonly splitDirection?: "horizontal" | "vertical";
}

interface RestoredState {
  readonly terminalIds: readonly string[];
  readonly activeTerminalId: string | null;
  readonly terminalGroups?: readonly RestoredGroup[];
  readonly activeTerminalGroupId?: string | null;
}

const RESTORED_GROUP_KEYS = new Set(["id", "terminalIds", "splitDirection"]);

function isRestoredGroup(value: unknown): value is RestoredGroup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { id?: unknown; terminalIds?: unknown; splitDirection?: unknown };
  return (
    Object.keys(value).every((key) => RESTORED_GROUP_KEYS.has(key)) &&
    typeof candidate.id === "string" &&
    Array.isArray(candidate.terminalIds) &&
    candidate.terminalIds.every((id) => typeof id === "string") &&
    (candidate.splitDirection === undefined ||
      candidate.splitDirection === "horizontal" ||
      candidate.splitDirection === "vertical")
  );
}

/**
 * Restore accepts both record shapes: pre-split state carried only
 * `terminalIds`/`activeTerminalId` — those records land as one singleton
 * group per session, exactly what they rendered before.
 */
function restoreState(value: unknown): value is RestoredState | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as {
    terminalIds?: unknown;
    activeTerminalId?: unknown;
    terminalGroups?: unknown;
    activeTerminalGroupId?: unknown;
  };
  return (
    Object.keys(value).every(
      (key) =>
        key === "terminalIds" ||
        key === "activeTerminalId" ||
        key === "terminalGroups" ||
        key === "activeTerminalGroupId",
    ) &&
    (candidate.terminalIds === undefined ||
      (Array.isArray(candidate.terminalIds) &&
        candidate.terminalIds.every((id) => typeof id === "string"))) &&
    (candidate.activeTerminalId === undefined ||
      typeof candidate.activeTerminalId === "string" ||
      candidate.activeTerminalId === null) &&
    (candidate.terminalGroups === undefined ||
      (Array.isArray(candidate.terminalGroups) &&
        candidate.terminalGroups.every(isRestoredGroup))) &&
    (candidate.activeTerminalGroupId === undefined ||
      typeof candidate.activeTerminalGroupId === "string" ||
      candidate.activeTerminalGroupId === null)
  );
}

function controlOps(host: ClientHost, session: ViewSession): TerminalControlOps {
  const api = bindApi(terminalControlApi, host, session.context);
  return {
    open: (input) => api.invoke("open", input, session.signal),
    attach: (input) => api.invoke("attach", input, session.signal),
    write: (input) => api.invoke("write", input, session.signal),
    resize: (input) => api.invoke("resize", input, session.signal),
    clear: (input) => api.invoke("clear", input, session.signal),
    restart: (input) => api.invoke("restart", input, session.signal),
    close: (input) => api.invoke("close", input, session.signal),
  };
}

/* ------------------------------------------------------------------ */
/* Format-4 package assets → WASM runtime + symbols font               */
/* ------------------------------------------------------------------ */

type GhosttyAssets =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly runtime: GhosttyRuntime; readonly symbolsFontUrl: string }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Load the vendored libghostty-vt closure through `host.readAsset`, once per
 * installation client (see assetLoader.ts). The host has already verified
 * each asset's sha256 against the package manifest; the media-type check
 * here is the last sanity gate before the bytes instantiate.
 */
const loadGhosttyAssets = sharedLoad(async (host: ClientHost) => {
  if (!host.readAsset) throw new Error("This host cannot load package assets.");
  const read: ReadAsset = host.readAsset.bind(host);
  // Every mount shares this load, so no one view's signal may cancel it; the
  // host still ends it with the installation lifetime.
  const signal = new AbortController().signal;
  const vt = await readAssetWithRetry(read, GHOSTTY_VT_ASSET, signal);
  const writePty = await readAssetWithRetry(read, GHOSTTY_WRITE_PTY_ASSET, signal);
  const font = await readAssetWithRetry(read, SYMBOLS_FONT_ASSET, signal);
  if (vt.mediaType !== "application/wasm" || writePty.mediaType !== "application/wasm") {
    throw new Error("Terminal WASM assets failed package verification.");
  }
  if (font.mediaType !== "font/woff2") {
    throw new Error("Terminal symbols font failed package verification.");
  }
  const runtime = await loadGhosttyRuntime({
    vt: vt.bytes.slice(),
    writePty: writePty.bytes.slice(),
  });
  return { runtime, symbolsFont: font.bytes };
});

function useGhosttyAssets(host: ClientHost, session: ViewSession): GhosttyAssets {
  const [state, setState] = useState<GhosttyAssets>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    let symbolsFontUrl: string | null = null;
    loadGhosttyAssets(host).then(
      ({ runtime, symbolsFont }) => {
        if (cancelled || session.signal.aborted) return;
        symbolsFontUrl = URL.createObjectURL(
          new Blob([symbolsFont as BlobPart], { type: "font/woff2" }),
        );
        setState({ kind: "ready", runtime, symbolsFontUrl });
      },
      (error: unknown) => {
        if (cancelled || session.signal.aborted) return;
        setState({
          kind: "unavailable",
          message: error instanceof Error ? error.message : "Terminal renderer unavailable",
        });
      },
    );
    return () => {
      cancelled = true;
      if (symbolsFontUrl !== null) URL.revokeObjectURL(symbolsFontUrl);
    };
  }, [host, session]);
  return state;
}

/* ------------------------------------------------------------------ */
/* Sessions list stream → panel                                        */
/* ------------------------------------------------------------------ */

function useSessionsStream(
  host: ClientHost,
  session: ViewSession,
  panel: TerminalPanel,
  visible: boolean,
) {
  // Layout effect on purpose: child pane effects run before the parent's
  // passive effects, and the panes would spend the whole stream budget
  // before the fixed feeds register — the feeds must pre-charge it.
  useLayoutEffect(() => {
    if (!visible) return;
    // The thread's session list is placement-independent — every visible
    // placement of the same thread joins ONE shared subscription (see
    // streamHub) instead of spending an installation stream each.
    const environmentId = session.context.resource.environmentId ?? "";
    const threadId = session.context.resource.threadId ?? "";
    return streamHub.acquireFixedFeed(
      `sessions:${environmentId}:${threadId}`,
      {
        onFrame: (frame: TerminalSessionsListEvent) => panel.applySessionsEvent(frame),
        onStatus: (status, message) => {
          if (status === "connecting") panel.beginListStream();
          else panel.markStreamDisconnected(message);
        },
      },
      (sink, signal) => {
        void (async () => {
          // A `closed` frame (queue overflow / terminal error) or a dropped
          // stream is recoverable: each fresh subscription starts from a new
          // snapshot. Bounded retries keep a noisy stream from spinning.
          // Broker refusals are tracked separately: capacity another client
          // of the installation is spending never reaches this hub, so the
          // panel stays "connecting" and backs off rather than burning the
          // closed-stream attempts or disabling New over capacity.
          let refusals = 0;
          for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt += 1) {
            sink.status("connecting", null);
            let closed = false;
            try {
              const stream = bindStreamApi(terminalSessionsApi, host, session.context).subscribe(
                "list",
                {},
                signal,
              );
              for await (const frame of stream) {
                if (signal.aborted) return;
                sink.frame(frame.value);
                if (frame.value.kind === "closed") {
                  closed = true;
                  break;
                }
              }
            } catch (error) {
              if (!signal.aborted && isBrokerStreamRefusal(error)) {
                refusals += 1;
                if (refusals > 8) {
                  sink.status("disconnected", "Session list stream was refused repeatedly.");
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 400 * refusals));
                attempt = 0; // capacity is not stream noise — keep the budget
                continue;
              }
              if (!signal.aborted)
                sink.status(
                  "disconnected",
                  error instanceof Error ? error.message : "Session list unavailable",
                );
              return;
            }
            if (signal.aborted) return;
            if (!closed) {
              sink.status("disconnected", null);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
          }
          if (!signal.aborted) sink.status("disconnected", "Session list stream ended repeatedly.");
        })();
      },
      // The feed is shared across placements, and a placement that mounts
      // while the feed is already live never sees a fresh snapshot — the
      // replayed [snapshot … deltas] history is what makes its panel go
      // live. Deltas only count on top of a snapshot.
      { isStateFrame: (frame) => frame.kind === "snapshot" },
    );
  }, [host, session, panel, visible]);
}

/* ------------------------------------------------------------------ */
/* t3.ui/* consumption — theme vars, appearance, panel commands        */
/* ------------------------------------------------------------------ */

/**
 * `t3.ui/theme` consumer. `getTokens` resolves the host's *effective* theme —
 * the provider's projection already folds the stored preference, live session
 * overlays, and external previews into the painted state — and each
 * `subscribeState` frame re-reads the tokens, so the panel tracks exactly
 * what the host paints without interpreting overlay semantics itself. The map
 * lands on the view root as `--t3-terminal-*` custom properties; a denied
 * read or a dead stream clears it and every style falls back to its legacy
 * `var()` chain — the honest degraded path.
 */
function useThemeVars(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
): Record<string, string> | null {
  const [vars, setVars] = useState<Record<string, string> | null>(null);
  // Layout effect like the sessions feed — fixed feeds pre-charge the
  // budget before pane effects (see useSessionsStream).
  useLayoutEffect(() => {
    if (!visible) return;
    // The host's theme is environment-global — one shared feed per
    // environment serves every placement (stream budget, see streamHub).
    return streamHub.acquireFixedFeed(
      `theme:${session.context.resource.environmentId ?? ""}`,
      { onFrame: setVars, onStatus: () => {} },
      (sink, signal) => {
        void watchThemeVars({
          client: host,
          context: session.context,
          signal,
          apply: (value) => sink.frame(value),
        });
      },
    );
  }, [host, session, visible]);
  return vars;
}

/**
 * `subscribeTerminalAppearance` consumer — the host's real terminal colors
 * and font. The stream opens with a snapshot frame, so no separate
 * `getTerminalAppearance` call is needed; when it dies the map clears back
 * to the token layer (or the legacy chain) governing. On the VT pane the
 * published `--t3-terminal-*` properties are what `terminalThemeFromApp`
 * resolves into the Ghostty theme — one pipeline from contract to surface,
 * no second interpreter.
 */
function useTerminalAppearanceVars(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
): Record<string, string> | null {
  const [vars, setVars] = useState<Record<string, string> | null>(null);
  // Layout effect like the sessions feed — fixed feeds pre-charge the
  // budget before pane effects (see useSessionsStream).
  useLayoutEffect(() => {
    if (!visible) return;
    // Shared per environment like the theme feed — the terminal appearance
    // is one host-wide fact, not a per-placement one.
    return streamHub.acquireFixedFeed(
      `appearance:${session.context.resource.environmentId ?? ""}`,
      { onFrame: setVars, onStatus: () => {} },
      (sink, signal) => {
        void watchTerminalAppearanceVars({
          client: host,
          context: session.context,
          signal,
          apply: (value) => sink.frame(value),
        });
      },
    );
  }, [host, session, visible]);
  return vars;
}

/** `t3.ui/panels` closeSurface against this view's own surface+thread. */
function closeOwnSurface(host: ClientHost, session: ViewSession): Promise<void> {
  const threadId = session.context.resource.threadId;
  if (threadId === undefined) return Promise.resolve();
  return bindApi(uiPanelsApi, host, session.context)
    .invoke("closeSurface", { surfaceId: TERMINAL_SURFACE_ID, threadId }, session.signal)
    .then(
      () => undefined,
      () => {
        throw new Error("The host could not close this panel.");
      },
    );
}

/**
 * `t3.ui/keybindings` consumer: registers the view's command set (toggle/new/
 * close/split/splitVertical) and binds the dispatch handler for the
 * focused-view and thread arbitration tiers. Every action stays panel-local —
 * `new`/`close`/`split` drive the group model (close keeps the inline
 * confirm), `toggle` dismisses the hosting surface through `t3.ui/panels`. A
 * denied or failing registration only loses palette/remap dispatch — the
 * captured chords and the toolbar buttons still work.
 */
function usePanelCommands(
  host: ClientHost,
  session: ViewSession,
  panel: TerminalPanel,
  visible: boolean,
  actions: TerminalCommandActions,
) {
  useEffect(() => {
    // bindCommands throws on a hidden view ("View is inactive") — registration
    // waits for visibility and unwinds when it drops.
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    let release: (() => void) | null = null;
    void registerPanelCommands({
      client: host,
      context: session.context,
      signal,
      bindCommands: (token, handler) => session.bindCommands(token, handler),
      onCommand: (commandId) => void dispatchTerminalCommand(commandId, actions),
    }).then(
      (registration) => {
        if (registration === null) return;
        if (signal.aborted) registration.release();
        else release = registration.release;
      },
      () => {
        // Denied or unavailable registration: no panel commands.
      },
    );
    return () => {
      controller.abort();
      release?.();
    };
  }, [host, session, panel, visible, actions]);
}

/* ------------------------------------------------------------------ */
/* VT pane: Ghostty surface + output stream + input queue wiring       */
/* ------------------------------------------------------------------ */

function writeSystemMessage(surface: Pick<GhosttyTerminalSurface, "write">, message: string) {
  surface.write(`\r\n[terminal] ${message}\r\n`);
}

/**
 * "Add to chat" through `t3.composer/context`: the server forwards to the
 * composer of the client that invoked it, so a remote browser fills its own
 * draft. Without a thread there is no chat to add to, as in native.
 */
function composerChatSink(
  host: ClientHost,
  session: ViewSession,
  panel: TerminalPanel,
  terminalId: string,
): TerminalChatSink | undefined {
  if (session.context.resource.threadId === undefined) return undefined;
  const composer = bindApi(composerContextApi, host, session.context);
  return {
    terminalId,
    terminalLabel: () =>
      panel.snapshot.tabs.find((tab) => tab.terminalId === terminalId)?.label ??
      getTerminalLabel(terminalId),
    probe: async () => {
      const capabilities = await composer.invoke("getCapabilities", {}, session.signal);
      return capabilities.transport === "client" && capabilities.operations.insertTerminalContext;
    },
    insert: (selection) => composer.invoke("insertTerminalContext", selection, session.signal),
  };
}

/**
 * Surface-local key intercepts the plugin owns: readline-style navigation,
 * line delete, and screen clear. The focused terminal chords are captured at
 * the view root (resolved by the host keymap — see terminalChordAction), so
 * `handleBeforeKey` only intercepts editing keys and never sees them.
 */
function handleBeforeKey(event: KeyboardEvent, panel: TerminalPanel, terminalId: string): boolean {
  const navigationData = terminalNavigationShortcutData(event);
  if (navigationData !== null) {
    event.preventDefault();
    event.stopPropagation();
    panel.sendInput(terminalId, navigationData);
    return false;
  }
  const deleteData = terminalDeleteShortcutData(event);
  if (deleteData !== null) {
    event.preventDefault();
    event.stopPropagation();
    panel.sendInput(terminalId, deleteData);
    return false;
  }
  if (!isTerminalClearShortcut(event)) return true;
  event.preventDefault();
  event.stopPropagation();
  panel.sendInput(terminalId, "\u000c");
  return false;
}

function TerminalPane(props: {
  readonly host: ClientHost;
  readonly session: ViewSession;
  readonly panel: TerminalPanel;
  readonly terminalId: string;
  /** Per-view prefix making the pane's hub slot unique per placement. */
  readonly streamKeyPrefix: string;
  /** The focused pane — receives surface focus and the active-pane border. */
  readonly active: boolean;
  /** Member of the visible split group — hidden panes stay mounted offscreen. */
  readonly shown: boolean;
  readonly visible: boolean;
  readonly assets: GhosttyAssets;
  readonly themeVars: Record<string, string> | null;
  readonly appearanceVars: Record<string, string> | null;
}) {
  const {
    host,
    session,
    panel,
    terminalId,
    streamKeyPrefix,
    active,
    shown,
    visible,
    assets,
    themeVars,
    appearanceVars,
  } = props;
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const [attachment] = useState(
    () =>
      new TerminalVtAttachment(terminalId, () => {
        bump();
      }),
  );
  const mountRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null);
  const [chatSink] = useState(() => composerChatSink(host, session, panel, terminalId));
  const selectionMenu = useTerminalSelectionMenu({
    mountRef,
    surfaceRef,
    reportError: writeSystemMessage,
    ...(chatSink ? { chat: chatSink } : {}),
  });
  const shownRef = useRef(shown && visible);
  // Latest active/shown state for the async surface creation: a surface
  // finishing after the focus effect last ran must know whether this pane
  // owns focus NOW, not at effect time.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Latest published appearance vars. The async create bakes them into
  // options.font and, once the surface exists, reconciles any publication
  // that landed while the create was pending (its setFont was skipped
  // because surfaceRef was still null).
  const appearanceVarsRef = useRef(appearanceVars);
  appearanceVarsRef.current = appearanceVars;

  // Epoch changes and lifecycle ends make queued input stale for the new
  // process incarnation — the panel drops them the moment the stream says
  // so. Every pane's output stream comes from the installation-wide slot
  // pool (streamHub): a visible pane holds a mandatory slot, a hidden pane
  // keeps an optional one — parser/query continuity across a group switch —
  // until some visible pane anywhere needs it. A pane that cannot get a
  // slot says so honestly and retries when one frees.
  const [streamBlocked, setStreamBlocked] = useState(false);
  const acquireStreamRef = useRef((_mandatory: boolean) => {});
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let run: { controller: AbortController; lease: TerminalPaneLease } | null = null;
    let retryRegistration: (() => void) | null = null;
    // Broker refusals are capacity this hub cannot see (another client
    // document of the installation, or the environment's 64-stream pool):
    // retry with capped backoff instead of erroring the pane, resetting
    // once a stream runs clean.
    let brokerRefusals = 0;
    let brokerRefusalTimer: ReturnType<typeof setTimeout> | null = null;
    const stopRun = () => {
      retryRegistration?.();
      retryRegistration = null;
      if (brokerRefusalTimer !== null) {
        clearTimeout(brokerRefusalTimer);
        brokerRefusalTimer = null;
      }
      const current = run;
      run = null;
      current?.lease.release();
      current?.controller.abort();
    };
    const acquire = (mandatory: boolean) => {
      if (stopped || run !== null) return;
      const lease = streamHub.acquirePaneStream(`${streamKeyPrefix}/${terminalId}`, {
        mandatory,
        onEvicted: () => {
          if (run?.lease === lease) stopRun();
        },
      });
      if (lease === null) {
        setStreamBlocked(true);
        // The hub drops one-shot waiters after firing, so each failed
        // acquire registers a fresh one. The retry re-reads visibility
        // when it fires: a hidden pane's waiter must retry as optional
        // or it seizes every demoted slot as mandatory, and the newly
        // visible pane starves behind permanently-mandatory hidden
        // holders that no priority effect will ever demote.
        retryRegistration = streamHub.onPaneSlotFree(() => acquire(shownRef.current));
        return;
      }
      setStreamBlocked(false);
      const controller = new AbortController();
      run = { controller, lease };
      // The pump start waits out the admission gate: when this acquire
      // evicted a pane, the victim's host-level teardown is still resolving
      // and an immediate subscribe would contend with it for one broker
      // slot. Evicted mid-gate (or unmounted), `run` no longer matches and
      // the pump never starts — the guard then reports this lease's settle
      // itself, so the eviction's replacement is not left waiting.
      void lease.admitted.then(() => {
        if (stopped || run?.controller !== controller) {
          lease.streamSettled();
          return;
        }
        let refused = false;
        void pumpTerminalOutput({
          subscribe: (subscribeSignal) => {
            const source = bindStreamApi(terminalOutputEventsApi, host, session.context).subscribe(
              "subscribe",
              { terminalId },
              subscribeSignal,
            );
            return (async function* () {
              for await (const frame of source) {
                const value = frame.value as TerminalOutputEventsValue;
                // identity-changed means a new process epoch and exit/error means
                // the process is gone — pending input is stale for both. Overflow
                // keeps the same incarnation; a reset is only a screen clear.
                if (value.kind === "closed" && value.reason !== "overflow") {
                  panel.resetInput(terminalId);
                }
                yield { streamId: frame.streamId, sequence: frame.sequence, value };
              }
            })();
          },
          attachment,
          signal: AbortSignal.any([controller.signal, session.signal]),
          refusal: isBrokerStreamRefusal,
          onRefused: () => {
            refused = true;
            brokerRefusals += 1;
            // The same honest waiting notice as a refused hub acquire: the
            // budget is spent elsewhere (possibly another client), so say
            // so and attach as soon as a slot frees. The `.finally` below
            // releases this lease first; the timer's re-acquire sees a free
            // effect and goes through the hub honestly.
            setStreamBlocked(true);
            brokerRefusalTimer = setTimeout(
              () => {
                brokerRefusalTimer = null;
                if (!stopped) acquire(shownRef.current);
              },
              Math.min(400 * brokerRefusals, 3200),
            );
          },
        }).finally(() => {
          // The pump ended — the stream finished, or evict/cleanup aborted it
          // and already released the lease (release is idempotent).
          if (run?.controller === controller) {
            run = null;
            lease.release();
          }
          // The stream this lease admitted has fully drained — exactly the
          // report any admission evicted for this slot is gated on.
          lease.streamSettled();
          // A clean end (stream finished or aborted, never refused) earns a
          // fresh backoff budget; refusals keep escalating to the cap.
          if (!refused) brokerRefusals = 0;
        });
      });
    };
    acquireStreamRef.current = (mandatory: boolean) => {
      if (run === null) {
        if (mandatory) acquire(true);
        return;
      }
      run.lease.setPriority(mandatory);
    };
    acquire(shownRef.current);
    return () => {
      stopped = true;
      acquireStreamRef.current = () => {};
      stopRun();
    };
  }, [host, session, panel, terminalId, attachment, visible, streamKeyPrefix]);

  // Group switches inside the view re-prioritize the pane's slot: shown
  // promotes to mandatory (re-acquiring after an eviction), hidden demotes
  // to the preemptable optional slot.
  useEffect(() => {
    acquireStreamRef.current(shown && visible);
  }, [shown, visible]);

  // Mount the vendored surface once the WASM runtime is ready; output that
  // arrived while WASM loaded replays through the attachment.
  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null || assets.kind !== "ready") return;
    let cancelled = false;
    let surface: GhosttyTerminalSurface | null = null;
    const themeObserver = new MutationObserver(() => {
      surface?.setTheme(terminalThemeFromApp(mount));
    });
    void (async () => {
      const createdFont = terminalFontFromVars(appearanceVarsRef.current);
      const options: GhosttyTerminalSurfaceOptions = {
        runtime: assets.runtime,
        symbolsFontUrl: assets.symbolsFontUrl,
        theme: terminalThemeFromApp(mount),
        font: createdFont,
        get visible() {
          return shownRef.current;
        },
        onData: (data) => panel.sendInput(terminalId, data),
        onResize: (cols, rows) => panel.resize(terminalId, cols, rows),
        onSelectionChange: selectionMenu.onSelectionChange,
        onContextMenu: selectionMenu.onContextMenu,
        beforeKey: (event) => handleBeforeKey(event, panel, terminalId),
        onLinkActivate: (text) => {
          // Terminal 22, path half: a detected path link opens through
          // t3.file/presentation (the files pack's provider), reported on the
          // surface. The URL half still has no external-open contract, so it
          // stays an honest refusal instead of a silent drop.
          if (surface === null) return;
          const paneSurface = surface;
          if (isTerminalUrl(text)) {
            writeSystemMessage(paneSurface, "Opening URLs is unavailable in this extension host.");
            return;
          }
          const workspace = workspaceLaunchFromRevision(session.context.workspaceRevision);
          const target =
            workspace === null
              ? null
              : terminalPathLinkTarget(text, workspace.cwd, workspace.workspaceRoot);
          if (target === null || target.status === "unopenable") {
            writeSystemMessage(
              paneSurface,
              target === null
                ? `${text} cannot be opened — the workspace is not available.`
                : target.reason,
            );
            return;
          }
          const signal = session.signal;
          void bindApi(filePresentationApi, host, session.context)
            .invoke("open", { relativePath: target.relativePath }, signal)
            .then(
              (result) => {
                if (!signal.aborted && surfaceRef.current === paneSurface) {
                  writeSystemMessage(
                    paneSurface,
                    `${target.relativePath} opens in ${result.surfaceId} · ${result.placement}`,
                  );
                }
              },
              (error: unknown) => {
                if (!signal.aborted && surfaceRef.current === paneSurface) {
                  writeSystemMessage(
                    paneSurface,
                    `${text} could not be opened — ${
                      error instanceof Error ? error.message : "presentation unavailable"
                    }`,
                  );
                }
              },
            );
        },
      };
      try {
        surface = await GhosttyTerminalSurface.create(mount, options);
      } catch (error) {
        // A failed mount must not leave a silently dead pane: the stream
        // keeps landing in the bounded pre-sink buffer and the error is
        // visible until a remount succeeds.
        if (!cancelled) {
          attachment.applySinkFailure(
            error instanceof Error
              ? `Terminal renderer failed to start: ${error.message}`
              : "Terminal renderer failed to start.",
          );
        }
        return;
      }
      if (cancelled) {
        surface.dispose();
        surface = null;
        return;
      }
      surface.setVisible(shownRef.current);
      // The theme observer is not installed yet; re-read in case the app
      // toggled light/dark while the surface was loading.
      surface.setTheme(terminalThemeFromApp(mount));
      // Appearance publications during the pending create ran the update
      // effect with surfaceRef still null, so their setFont calls were
      // skipped — reconcile the latest vars onto the new surface. Skip the
      // call when nothing changed (a same-value setFont still pays a font
      // load and re-measure).
      const latestFont = terminalFontFromVars(appearanceVarsRef.current);
      if (latestFont.family !== createdFont.family || latestFont.size !== createdFont.size) {
        void surface.setFont(latestFont).catch(() => {});
      }
      surfaceRef.current = surface;
      // A pane that was already the focused one while its surface was still
      // creating — the fresh-split case — owns focus the moment the surface
      // exists. The [active, shown, visible] effect cannot deliver it: it
      // ran before the async create assigned the ref and its deps never
      // change again for a freshly split pane, so without this call the new
      // pane would never take focus (keystrokes landing in the old pane).
      // Recreated surfaces (assets reloading) get the same reconciliation.
      if (activeRef.current && shownRef.current) surface.focus();
      try {
        attachment.attach(surface);
      } catch {
        // Replay failed mid-mount: attach() already flagged the pane
        // errored and dropped the half-written sink — dispose the dead
        // surface so a later remount starts clean instead of showing a
        // renderer that was never attached.
        surface.dispose();
        surface = null;
        surfaceRef.current = null;
        return;
      }
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    })();
    return () => {
      cancelled = true;
      themeObserver.disconnect();
      attachment.detach();
      surface?.dispose();
      surfaceRef.current = null;
    };
  }, [
    host,
    session,
    assets,
    attachment,
    panel,
    terminalId,
    selectionMenu.onContextMenu,
    selectionMenu.onSelectionChange,
  ]);

  useEffect(() => {
    shownRef.current = shown && visible;
    surfaceRef.current?.setVisible(shown && visible);
    if (active && shown && visible) surfaceRef.current?.focus();
  }, [active, shown, visible]);

  // The contract layers republish `--t3-terminal-*` on the view root; the
  // surface re-reads them through terminalThemeFromApp whenever either feed
  // publishes or clears, so a theme change reaches the canvas without a
  // remount. Font follows the same single pipeline: the published map is
  // the whole request — a cleared feed yields `{}` and setFont resets the
  // surface to its packaged defaults. A rejected font load just keeps the
  // current metrics, so the promise is swallowed.
  useEffect(() => {
    const mount = mountRef.current;
    if (mount !== null) surfaceRef.current?.setTheme(terminalThemeFromApp(mount));
    void surfaceRef.current?.setFont(terminalFontFromVars(appearanceVars)).catch(() => {});
  }, [themeVars, appearanceVars]);

  const state = attachment.state;
  const muted = "var(--muted-foreground, #667085)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <output
        aria-label="Output status"
        style={{ padding: "6px 10px", color: muted, fontSize: 12, flexShrink: 0 }}
      >
        {terminalId}: {state.statusText}
      </output>
      {state.degraded && (
        <output
          aria-label="Attach degraded"
          style={{ padding: "4px 10px", color: muted, fontSize: 12, flexShrink: 0 }}
        >
          Attached with truncated history — modes and screen state before the retained tail are
          unknown, so interactive parity is not claimed until the next full snapshot.
        </output>
      )}
      {streamBlocked && (
        <output
          aria-label="Stream budget"
          style={{ padding: "4px 10px", color: muted, fontSize: 12, flexShrink: 0 }}
        >
          Waiting for a free output stream — close a pane here or in another terminal panel, and
          this pane attaches as soon as one frees.
        </output>
      )}
      <div
        ref={mountRef}
        aria-label="Terminal output"
        data-t3-terminal-output
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          // Real properties carrying the contract chains — they resolve
          // var() references at use time, which is exactly what
          // terminalThemeFromApp needs (getPropertyValue on a custom
          // property would return the unresolved token stream).
          background: "var(--t3-terminal-background, var(--terminal-background, transparent))",
          color: "var(--t3-terminal-foreground, var(--terminal-foreground, inherit))",
          // Bridges the published --t3-terminal-color-scheme into the real
          // property terminalThemeFromApp reads for its dark fallback.
          colorScheme: "var(--t3-terminal-color-scheme, normal)",
        }}
      />
      {selectionMenu.menu}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Text fallback for hosts without package-asset reads                 */
/* ------------------------------------------------------------------ */

/** Live output via the public output-events stream; chunk groups reassemble in the view model. */
function useTerminalOutput(
  host: ClientHost,
  session: ViewSession,
  terminalId: string | null,
  visible: boolean,
) {
  const [state, setState] = useState<{ terminalId: string; buffer: OutputBuffer } | null>(null);
  const pendingRef = useRef<{ sequence: number; count: number; parts: string[] } | null>(null);
  useEffect(() => {
    pendingRef.current = null;
    if (!visible || terminalId === null) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      let streak = EMPTY_OVERFLOW_STREAK;
      let overflowClose = false;
      while (!signal.aborted) {
        pendingRef.current = null;
        const stateRef = { current: EMPTY_OUTPUT_BUFFER as OutputBuffer };
        let resurrect = false;
        try {
          const stream = bindStreamApi(terminalOutputEventsApi, host, session.context).subscribe(
            "subscribe",
            { terminalId },
            signal,
          );
          for await (const frame of stream) {
            if (signal.aborted) return;
            const value = frame.value as TerminalOutputEventsValue;
            streak = noteOutputFrameForStreak(value, streak, Date.now());
            if (value.kind === "closed") {
              overflowClose = value.reason === "overflow";
              resurrect = isResumableOutputClose(value.reason, streak.attempts);
              if (!resurrect && !stateRef.current.ended) {
                const applied = applyOutputEvent(
                  stateRef.current,
                  frame,
                  value,
                  pendingRef.current,
                );
                pendingRef.current = applied.pending;
                stateRef.current = applied.buffer;
                setState({ terminalId, buffer: applied.buffer });
              }
              break;
            }
            if (stateRef.current.ended) continue; // scan for a trailing closed frame
            const applied = applyOutputEvent(stateRef.current, frame, value, pendingRef.current);
            pendingRef.current = applied.pending;
            stateRef.current = applied.buffer;
            setState({ terminalId, buffer: applied.buffer });
          }
          if (!signal.aborted && !resurrect && pendingRef.current !== null) {
            stateRef.current = {
              ...EMPTY_OUTPUT_BUFFER,
              status: "error",
              statusText: "Output ended with an incomplete chunk group.",
              ended: true,
            };
            setState({ terminalId, buffer: stateRef.current });
          }
        } catch (error) {
          if (!signal.aborted) {
            const buffer: OutputBuffer = {
              ...EMPTY_OUTPUT_BUFFER,
              status: "error",
              statusText: error instanceof Error ? error.message : "Terminal output unavailable",
              ended: true,
            };
            setState({ terminalId, buffer });
          }
          return;
        }
        if (!resurrect) return;
        if (!signal.aborted) setState({ terminalId, buffer: EMPTY_OUTPUT_BUFFER });
        if (overflowClose && streak.attempts > 1 && !signal.aborted)
          await new Promise((resolve) => setTimeout(resolve, 300 * streak.attempts));
      }
    })();
    return () => controller.abort();
  }, [host, session, terminalId, visible]);
  return state?.terminalId === terminalId ? state.buffer : null;
}

/** Fit→resize on the visible terminal; latest-wins scheduling lives in the panel. */
function useFitResize(
  panel: TerminalPanel,
  terminalId: string | null,
  ref: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const element = ref.current;
    if (!element || terminalId === null || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const rect = element.getBoundingClientRect();
      const cols = Math.max(1, Math.floor(rect.width / 7.5));
      const rows = Math.max(1, Math.floor(rect.height / 16));
      panel.resize(terminalId, cols, rows);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel, terminalId, ref]);
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

/*
 * Native control idiom (cert term-8): the native terminal chrome leaves its
 * controls at the host's control size instead of shrinking them — text-sm
 * ghost buttons, transparent at rest, no border, with the focus-ring style
 * block on the panel root supplying keyboard affordance.
 */
const control = {
  padding: "4px 8px",
  border: "1px solid transparent",
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
} as const;

function TerminalView(props: { host: ClientHost; session: ViewSession }) {
  const { host, session } = props;
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const streamKeyPrefix = useId();
  const [panel] = useState(() => {
    const restored =
      session.restoreState &&
      typeof session.restoreState === "object" &&
      !Array.isArray(session.restoreState)
        ? (session.restoreState as unknown as RestoredState)
        : null;
    const workspace = workspaceLaunchFromRevision(session.context.workspaceRevision);
    const launch =
      workspace === null
        ? null
        : {
            cwd: workspace.cwd,
            worktreePath: workspace.worktreePath,
            env: projectScriptRuntimeEnv({
              project: { cwd: workspace.workspaceRoot },
              worktreePath: workspace.worktreePath,
            }),
          };
    let panel: TerminalPanel;
    panel = new TerminalPanel({
      control: controlOps(host, session),
      launch,
      restored,
      // The installation-wide pane budget gates open/split BEFORE any PTY
      // spawns: a terminal that could never get an output stream would
      // render as a dead pane until something else closed.
      canAllocatePaneStream: () => streamHub.paneSlotAvailable(),
      onChange: () => {
        const snapshot = panel.snapshot;
        session.save({
          terminalIds: [...snapshot.terminalIds],
          activeTerminalId: snapshot.activeTerminalId,
          terminalGroups: snapshot.groups.map((group) => ({
            id: group.id,
            terminalIds: [...group.terminalIds],
            // The native group shape stores only "vertical"; absent reads
            // as horizontal, so the default direction stays unwritten.
            ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
          })),
          activeTerminalGroupId: snapshot.activeGroupId,
        });
        bump();
      },
    });
    return panel;
  });
  const [visible, setVisible] = useState(session.visible);
  const [input, setInput] = useState("");
  const outputRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => session.onVisibility(setVisible), [session]);
  useEffect(() => () => panel.dispose(), [panel]);
  useSessionsStream(host, session, panel, visible);
  // The one action funnel both dispatch paths share: registered
  // `t3.ui/keybindings` commands and the captured focused-terminal chords.
  // Stable identity — the command registration effect keys on it.
  const panelActions = useMemo<TerminalCommandActions>(
    () => ({
      newTerminal: () => void panel.openTerminal(),
      closeTerminal: () => {
        const activeId = panel.snapshot.activeTerminalId;
        if (activeId !== null) panel.requestAction(activeId, "close");
      },
      splitTerminal: (direction) => void panel.splitTerminal(direction),
      toggleSurface: () =>
        void closeOwnSurface(host, session).catch((error: unknown) =>
          panel.notePanelError(error instanceof Error ? error.message : "Panel action failed"),
        ),
    }),
    [panel, host, session],
  );
  usePanelCommands(host, session, panel, visible, panelActions);
  const themeVars = useThemeVars(host, session, visible);
  const appearanceVars = useTerminalAppearanceVars(host, session, visible);
  const assets = useGhosttyAssets(host, session);
  const snapshot: TerminalPanelSnapshot = panel.snapshot;
  const activeId = snapshot.activeTerminalId;
  const activeTab = snapshot.tabs.find((tab) => tab.terminalId === activeId) ?? null;
  // The active group's members render side-by-side; every other session
  // keeps its pane mounted offscreen — offscreen panes hold optional stream
  // slots (streamHub) so the VT parser keeps consuming output and answering
  // program queries, and they promote when their group becomes visible.
  const activeGroup = snapshot.groups.find((group) => group.id === snapshot.activeGroupId) ?? null;
  const visibleTerminalIds = activeGroup?.terminalIds ?? (activeId !== null ? [activeId] : []);
  const visibleSet = new Set(visibleTerminalIds);
  const splitDirection = activeGroup?.splitDirection ?? "horizontal";
  // DOM order: visible panes in group order first, then hidden panes — the
  // keyed reorder keeps every VT attachment mounted across group switches.
  const paneOrder = [
    ...visibleTerminalIds,
    ...snapshot.terminalIds.filter((id) => !visibleSet.has(id)),
  ];
  const tabById = new Map(snapshot.tabs.map((tab) => [tab.terminalId, tab]));
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const showGroupHeaders =
    snapshot.groups.length > 1 || snapshot.groups.some((group) => group.terminalIds.length > 1);
  const textFallback = assets.kind === "unavailable";
  const output = useTerminalOutput(
    host,
    session,
    textFallback ? activeId : null,
    visible && textFallback,
  );
  useFitResize(panel, textFallback ? activeId : null, outputRef);
  const outputContents = output?.contents ?? "";
  const plainOutput = useMemo(() => plainTerminalText(outputContents), [outputContents]);

  const send = () => {
    if (activeId === null || input.length === 0) return;
    panel.sendInput(activeId, input + "\r");
    setInput("");
  };

  const muted = "var(--t3-terminal-muted, var(--muted-foreground, #667085))";
  const border = "1px solid var(--t3-terminal-border, var(--border, #dfe3e8))";
  return (
    <section
      aria-label="Terminal"
      onKeyDownCapture={(event) => {
        // The host's window-capture dispatcher runs first and preventDefaults
        // any chord it actually dispatched — including this surface's own
        // registered commands — so an event still un-prevented here was left
        // for this surface to act on.
        if (event.defaultPrevented) return;
        // The host resolves the chord the way its dispatcher just did, so a
        // remapped chord dispatches the RESOLVED command (mod+d →
        // terminal.close closes instead of splitting) and anything else is
        // left alone. Capture stays ahead of the VT surface's encoder, which
        // would otherwise send the chord's bytes to the PTY.
        const action = terminalChordAction(
          event.nativeEvent,
          host.keybindings,
          isMacPlatform(navigator.platform),
        );
        if (action !== null && dispatchTerminalCommand(action, panelActions)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        color: "var(--t3-terminal-text, var(--foreground, #20252d))",
        background: "var(--t3-terminal-canvas, var(--background, #fff))",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        // Contract-derived custom properties inherit to every descendant —
        // the chrome's var() chains, the fallback <pre>, and the mount div
        // terminalThemeFromApp resolves into the Ghostty theme.
        ...themeVars,
        ...appearanceVars,
      }}
      data-t3-terminal-panel
    >
      <style>
        {`[data-t3-terminal-output]::selection{background:var(--t3-terminal-selection,Highlight)}
[data-t3-terminal-panel] :is(button,input,select,textarea):focus-visible{outline:none;box-shadow:0 0 0 1px var(--t3-terminal-canvas, var(--background, #fff)),0 0 0 3px var(--ring, var(--primary, #1b4ed8))}`}
      </style>
      <header
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderBottom: border,
          flexShrink: 0,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => void panel.openTerminal()}
          disabled={snapshot.stream !== "live"}
          style={control}
        >
          New terminal
        </button>
        <button
          type="button"
          onClick={() => void panel.splitTerminal("horizontal")}
          disabled={snapshot.stream !== "live" || hasReachedSplitLimit}
          style={control}
        >
          Split horizontally
          {hasReachedSplitLimit ? ` (max ${MAX_TERMINALS_PER_GROUP} per group)` : ""}
        </button>
        <button
          type="button"
          onClick={() => void panel.splitTerminal("vertical")}
          disabled={snapshot.stream !== "live" || hasReachedSplitLimit}
          style={control}
        >
          Split vertically
          {hasReachedSplitLimit ? ` (max ${MAX_TERMINALS_PER_GROUP} per group)` : ""}
        </button>
        <span style={{ color: muted, fontSize: 12 }}>
          {snapshot.stream === "closed"
            ? "Session list disconnected"
            : snapshot.stream === "connecting"
              ? "Connecting…"
              : ""}
        </span>
      </header>
      <ul
        aria-label="Terminal sessions"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 6,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {snapshot.groups.map((group) => (
          <li key={group.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {showGroupHeaders && (
              <button
                type="button"
                aria-label={`Activate terminal group ${group.id}`}
                onClick={() => {
                  const target = group.terminalIds.includes(activeId ?? "")
                    ? activeId!
                    : group.terminalIds[0];
                  if (target !== undefined) panel.activate(target);
                }}
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  padding: "2px 6px",
                  border: "1px solid transparent",
                  borderRadius: 5,
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 11,
                  color: snapshot.activeGroupId === group.id ? "inherit" : muted,
                  background:
                    snapshot.activeGroupId === group.id
                      ? "var(--t3-terminal-accent-surface, var(--accent, #e8eef7))"
                      : "transparent",
                }}
              >
                <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  {group.terminalIds.length === 1
                    ? "Single"
                    : group.splitDirection === "vertical"
                      ? "Stacked"
                      : "Side by side"}
                </span>
                <span style={{ fontSize: 10 }}>{group.terminalIds.length}</span>
              </button>
            )}
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {group.terminalIds.map((terminalId) => {
                const tab = tabById.get(terminalId);
                if (!tab) return null;
                return (
                  <li
                    key={tab.terminalId}
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <button
                      type="button"
                      aria-current={tab.terminalId === activeId ? "true" : undefined}
                      onClick={() => panel.activate(tab.terminalId)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: "left",
                        padding: "4px 6px",
                        border: "1px solid transparent",
                        borderRadius: 5,
                        cursor: "pointer",
                        font: "inherit",
                        fontSize: 12,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "inherit",
                        background:
                          tab.terminalId === activeId
                            ? "var(--t3-terminal-accent-surface, var(--accent, #e8eef7))"
                            : "transparent",
                      }}
                    >
                      {tab.label}
                    </button>
                    <span style={{ color: muted, fontSize: 11 }}>
                      {tab.status}
                      {tab.hasRunningSubprocess ? " · running" : ""}
                      {tab.queuedInputCount > 0 ? ` · queued ${tab.queuedInputCount}` : ""}
                    </span>
                    {tab.confirmAction === null ? (
                      <>
                        {(tab.status === "exited" ||
                          tab.status === "error" ||
                          tab.status === "closed") && (
                          <button
                            type="button"
                            aria-label={`Start ${tab.terminalId}`}
                            onClick={() => void panel.startSession(tab.terminalId)}
                            style={control}
                          >
                            Start
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`Clear ${tab.terminalId}`}
                          onClick={() => panel.requestAction(tab.terminalId, "clear")}
                          style={control}
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          aria-label={`Restart ${tab.terminalId}`}
                          onClick={() => panel.requestAction(tab.terminalId, "restart")}
                          style={control}
                        >
                          Restart
                        </button>
                        <button
                          type="button"
                          aria-label={`Close ${tab.terminalId}`}
                          onClick={() => panel.requestAction(tab.terminalId, "close")}
                          style={control}
                        >
                          ×
                        </button>
                      </>
                    ) : (
                      <>
                        <span style={{ color: muted, fontSize: 12 }}>
                          {tab.confirmAction === "close"
                            ? "Close this terminal?"
                            : tab.confirmAction === "restart"
                              ? "Restart this terminal?"
                              : "Clear history?"}
                        </span>
                        <button
                          type="button"
                          aria-label={`Confirm ${tab.confirmAction} ${tab.terminalId}`}
                          onClick={() => void panel.confirmAction(tab.terminalId)}
                          style={control}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel ${tab.confirmAction} ${tab.terminalId}`}
                          onClick={() => panel.cancelAction(tab.terminalId)}
                          style={control}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {snapshot.tabs.length === 0 && (
        <p style={{ padding: "6px 10px", color: muted, fontSize: 12, margin: 0 }}>
          No terminals yet. New terminal opens a shell in this workspace.
        </p>
      )}
      {snapshot.panelError && (
        <output
          aria-label="Panel status"
          style={{ padding: "4px 10px", color: muted, fontSize: 12 }}
        >
          {snapshot.panelError}
        </output>
      )}
      {activeTab?.inputStopped && (
        <div
          role="alert"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "6px 10px",
            fontSize: 12,
            color: muted,
            borderTop: border,
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{activeTab.inputMessage}</span>
          <button
            type="button"
            onClick={() => activeId !== null && panel.resumeInput(activeId)}
            style={control}
          >
            Resume input
          </button>
        </div>
      )}
      {assets.kind === "loading" && activeId !== null && (
        <output
          aria-label="Renderer status"
          style={{ padding: "6px 10px", color: muted, fontSize: 12 }}
        >
          Loading terminal renderer…
        </output>
      )}
      {assets.kind === "unavailable" && (
        <output
          aria-label="Renderer status"
          style={{ padding: "6px 10px", color: muted, fontSize: 12 }}
        >
          VT renderer unavailable ({assets.message}) — showing a plain-text view.
        </output>
      )}
      {!textFallback && (
        <div
          aria-label="Terminal panes"
          style={{
            display: "flex",
            flexDirection: splitDirection === "vertical" ? "column" : "row",
            flex: 1,
            minHeight: 0,
            minWidth: 0,
          }}
        >
          {paneOrder.map((terminalId, index) => {
            const shown = visibleSet.has(terminalId);
            const focused = terminalId === activeId;
            return (
              <div
                key={terminalId}
                data-t3-terminal-pane={terminalId}
                onMouseDown={
                  shown && !focused
                    ? () => {
                        panel.activate(terminalId);
                      }
                    : undefined
                }
                style={{
                  display: shown ? "flex" : "none",
                  flexDirection: "column",
                  flex: "1 1 0",
                  minWidth: 0,
                  minHeight: 0,
                  borderLeft:
                    splitDirection === "horizontal" && index > 0
                      ? `1px solid ${
                          focused
                            ? "var(--t3-terminal-border, var(--border, #dfe3e8))"
                            : "var(--t3-terminal-muted, var(--border, #dfe3e8))"
                        }`
                      : undefined,
                  borderTop:
                    splitDirection === "vertical" && index > 0
                      ? `1px solid ${
                          focused
                            ? "var(--t3-terminal-border, var(--border, #dfe3e8))"
                            : "var(--t3-terminal-muted, var(--border, #dfe3e8))"
                        }`
                      : undefined,
                }}
              >
                <TerminalPane
                  host={host}
                  session={session}
                  panel={panel}
                  terminalId={terminalId}
                  streamKeyPrefix={streamKeyPrefix}
                  active={focused}
                  shown={shown}
                  visible={visible}
                  assets={assets}
                  themeVars={themeVars}
                  appearanceVars={appearanceVars}
                />
              </div>
            );
          })}
        </div>
      )}
      {textFallback && activeId !== null && activeTab !== null && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            borderTop: border,
          }}
        >
          <output
            aria-label="Output status"
            style={{ padding: "6px 10px", color: muted, fontSize: 12, flexShrink: 0 }}
          >
            {activeId}: {activeTab.exitBanner ?? output?.statusText ?? "Connecting…"}
            {activeTab.error ? ` — ${activeTab.error}` : ""}
          </output>
          <pre
            ref={outputRef}
            aria-label="Terminal output"
            data-t3-terminal-output
            style={{
              flex: 1,
              minHeight: 0,
              margin: 0,
              padding: 12,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              color: "var(--t3-terminal-foreground, var(--terminal-foreground, inherit))",
              background: "var(--t3-terminal-background, var(--terminal-background, transparent))",
              fontFamily:
                "var(--t3-terminal-font-family, var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace))",
              fontSize: "var(--t3-terminal-font-size, 12px)",
              lineHeight: "var(--t3-terminal-line-height, normal)",
              fontVariantLigatures: "var(--t3-terminal-ligatures, normal)",
              colorScheme: "var(--t3-terminal-color-scheme, normal)",
            }}
          >
            {plainOutput}
          </pre>
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: 8,
              borderTop: border,
              flexShrink: 0,
            }}
          >
            <input
              aria-label="Terminal input"
              placeholder={activeTab.starting ? "Starting… input is queued" : "Type a command"}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") send();
              }}
              style={{
                ...control,
                flex: 1,
                minWidth: 0,
                cursor: "text",
                background: "var(--t3-terminal-input, var(--input, transparent))",
              }}
            />
            <button type="button" onClick={send} style={control}>
              Send
            </button>
          </div>
        </div>
      )}
      <output
        aria-label="Slice notice"
        style={{ padding: "6px 10px", color: muted, fontSize: 12, flexShrink: 0 }}
      >
        Ghostty VT rendering over the public control contract; theme, terminal appearance, and panel
        keybindings follow the host's t3.ui/* providers. Link activation is reported inline — there
        is no transient-toast path, so t3.ui/notifications is not adopted.
      </output>
    </section>
  );
}

const authored = defineExtension({
  id: manifestId,
  version: "0.3.0",
  requires: [
    requireApi(terminalSessionsApi),
    requireApi(terminalOutputApi),
    requireApi(terminalOutputEventsApi),
    requireApi(terminalControlApi),
    // "Add to chat" (insertTerminalContext is 1.1.0). The host provider is
    // always registered; getCapabilities reports whether a composer is there.
    requireApi(composerContextApi),
    // Path links open through the files pack's presentation provider. A
    // denied or failing invoke degrades to an honest surface message, so
    // only a provider-less host (no files installation) blocks the package.
    requireApi(filePresentationApi),
    // Mandatory requirements — the broker only authorizes invocations for
    // declared APIs, so the t3.ui/* contracts must be declared even though
    // the panel degrades per-call. A host without these providers resolves
    // the package missing-api rather than mounting it; the degraded paths
    // cover denied or failing calls and dead streams on a capable host.
    requireApi(uiThemeApi),
    // 1.1.0 only adds the optional host.keybindings resolver, which the
    // panel feature-detects (default chords without it), so a 1.0.0 host
    // still loads the panel.
    requireApi(uiKeybindingsApi, "^1.0.0"),
    requireApi(uiPanelsApi),
  ],
  assets: [
    { path: GHOSTTY_VT_ASSET, mediaType: "application/wasm" },
    { path: GHOSTTY_WRITE_PTY_ASSET, mediaType: "application/wasm" },
    { path: SYMBOLS_FONT_ASSET, mediaType: "font/woff2" },
    { path: "assets/SymbolsNerdFontMono-LICENSE.txt", mediaType: "application/octet-stream" },
    { path: "assets/libghostty-vt-LICENSE.txt", mediaType: "application/octet-stream" },
    { path: "assets/libghostty-vt-VERSION.txt", mediaType: "application/octet-stream" },
  ],
  surfaces: [
    {
      name: "view",
      title: "Terminal",
      scope: "thread",
      placements: ["side-panel", "bottom-dock"],
      clients: ["web", "desktop"],
      capabilities: [],
      // Owning focus-owner arbitration: the host tags the frame
      // `data-terminal-owner="extension"` and leaves the focused terminal
      // chords (split/splitVertical/new/close) to this view's keybindings.
      // The claim is only honest because the panel implements all four.
      claimsTerminalFocus: true,
      stateVersion: 1,
      validateRestore: restoreState,
      createView(host, session) {
        return { renderer: () => <TerminalView host={host} session={session} /> };
      },
    },
  ],
});

const clientFactory = authored.client;

export default {
  ...authored,
  ...(clientFactory === undefined
    ? {}
    : {
        client(host: ClientHost) {
          // Installation-tier command set: the toggle's cold-open activation
          // fallback. Staged at factory time; the host flushes it once the
          // installation commits and a client-provider connection is live.
          // Absent on hosts without the seam — the view set still works.
          host.registerGlobalCommands?.(TERMINAL_GLOBAL_COMMANDS);
          return clientFactory(host);
        },
      }),
};
