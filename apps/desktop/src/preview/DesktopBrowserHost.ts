// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/** The manager owns the single debugger attachment; the relay shares it. */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  createCdpRelayConnection,
  type CdpRelayConnection,
  type CdpRelayPopup,
  type CdpRelayTarget,
} from "./CdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
const AGENT_INPUT_METHOD = /^(?:Input\.|Page\.navigate$|Runtime\.(?:evaluate|callFunctionOn)$)/;
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;
const FOCUS_IDLE = "5 seconds";
/** Well inside the server's 10 s DESKTOP_ATTACH_TIMEOUT, for a first page that never reports it is up. */
const FIRST_PAGE_TIMEOUT = "5 seconds";
const ERR_ABORTED = -3;

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

/** A page the relay drives: the tab's own, or a popup it opened. */
interface AttachedTarget {
  readonly tab: AttachedTab;
  readonly debuggee: DesktopBrowserTabDebugger;
  screenshotTurn: object | null;
  /** Each holds focus and painting while `held` and whoever queued it still waits on it. */
  readonly waitingScreenshots: Array<{
    readonly start: () => void;
    readonly live: () => boolean;
    held: boolean;
  }>;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  focusEmulated: boolean;
  focusChange: Promise<void> | null;
  focusUses: number;
  /** Each pending command, by the extra session waiting on it; the main connection's have none. */
  readonly focusPending: Map<
    object,
    { readonly owner: string | undefined; readonly paints: boolean }
  >;
  /**
   * Driven by the agent since its thread's last turn ended or the guest last throttled. A
   * turn's start can reach us after its first command, so this holds focus once it does.
   */
  agentUsed: boolean;
  focusReleasing: boolean;
  /** The sessions streaming the guest; one stopping leaves the others' screencasts running. */
  readonly screencasts: Set<string | undefined>;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
  readonly onNewDocument: () => void;
}

/** Sessions of one relay connection, which its page and popups share. */
interface RelayOwners {
  readonly detached: Set<string>;
  /** Viewers and recordings stream; the agent's own sessions never do. */
  readonly streaming: Set<string>;
}

interface AttachedTab extends AttachedTarget {
  readonly key: DesktopBrowserTabKey;
  relay: CdpRelayConnection | null;
  owners: RelayOwners;
  /** Whether the client keeps the guest painting, as published on `painting`. */
  painting: boolean;
  /** Set while the server drives the tab for an agent, whose popups become its tabs too. */
  showsPopups: boolean;
  readonly popups: Map<Electron.WebContents, AttachedPopup>;
  /** Stops waiting for the first page; set until the tab is announced. */
  stopWaiting: (() => void) | null;
}

interface AttachedPopup extends AttachedTarget {
  relayed: CdpRelayPopup | null;
  readonly onDetach: () => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    readonly events: Stream.Stream<Uint8Array>;
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    readonly detach: (key: DesktopBrowserTabKey) => void;
    /** A guest opened a popup window; a tab the server drives for an agent shows it as a tab too. */
    readonly openedPopup: (opener: Electron.WebContents, popup: Electron.WebContents) => void;
    readonly setShown: (key: DesktopBrowserTabKey, shown: boolean | undefined) => void;
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
    /** Whether a guest needs its frames painted while the panel hides it. */
    readonly painting: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly active: boolean;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const outbox = yield* PubSub.unbounded<DesktopBrowserEventType>();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const painting = yield* PubSub.unbounded<{
    readonly key: DesktopBrowserTabKey;
    readonly active: boolean;
  }>();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const tabs = new Map<string, AttachedTab>();
  /** Every guest's open popups, so a tab the server starts driving later still shows them. */
  const openedPopups = new Map<Electron.WebContents, Set<Electron.WebContents>>();
  /** Threads whose agent turn runs, by the server's account. */
  const agentTurns = new Set<string>();
  // Kept apart from attachment: the renderer can show a webview before its debugger attaches,
  // and the server forgets `shown` on detach, for example while DevTools holds the debugger.
  const shownTabs = new Map<string, boolean>();
  const emit = (event: DesktopBrowserEventType) => runFork(PubSub.publish(outbox, event));

  const isAttached = (target: AttachedTarget) =>
    tabs.get(keyOf(target.tab.key)) === target.tab &&
    (target === target.tab || target.tab.popups.get(target.debuggee.webContents) === target);

  const nextScreenshot = (target: AttachedTarget) => {
    target.screenshotTurn = null;
    target.waitingScreenshots.shift()?.start();
    releaseFocusWhenIdle(target);
    syncPainting(target);
  };

  /**
   * Chromium below 157 crashes the whole app when a guest's renderer exits with a
   * screenshot copy in flight (crbug.com/567321049). Overlapping screenshots make that
   * far likelier, and one the server gave up on stays pending in Chromium, so each guest
   * gets one at a time. One whose relay or session has since gone is dropped unsent.
   */
  const takeScreenshot = (
    target: AttachedTarget,
    relay: CdpRelayConnection,
    ownerLive: () => boolean,
    /** Sends only while `current` holds; holds focus and painting only while `held`. */
    capture: (current: () => boolean, held: boolean) => Promise<unknown>,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const live = () => target.tab.relay === relay && isAttached(target) && ownerLive();
      const waiting = {
        start: () => {
          if (!live()) {
            reject(new Error("The preview connection that asked for this screenshot closed."));
            nextScreenshot(target);
            return;
          }
          const turn = {};
          target.screenshotTurn = turn;
          capture(() => target.screenshotTurn === turn && live(), waiting.held)
            .finally(() => {
              if (target.screenshotTurn === turn) nextScreenshot(target);
            })
            .then(resolve, reject);
        },
        live,
        held: true,
      };
      if (target.screenshotTurn === null) waiting.start();
      else {
        // The one ahead may be abandoned mid-capture; it needs frames to finish and free its turn.
        target.waitingScreenshots.push(waiting);
        setFocusEmulation(target, true);
        syncPainting(target);
      }
    });

  /**
   * Chromium counts a focus-emulated guest as captured, so a guest the panel hides would
   * never throttle. Without it, a hidden guest paints no frames and focus() fires no focus
   * events, so the guest is emulated focused while the server drives it or streams it.
   */
  const setFocusEmulation = (target: AttachedTarget, enabled: boolean) => {
    if (target.focusEmulated === enabled) return;
    target.focusEmulated = enabled;
    // A guest that refuses it, or a debugger already gone, behaves as unfocused.
    const change: Promise<void> = target.debuggee.debugger
      .sendCommand("Emulation.setFocusEmulationEnabled", { enabled })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (target.focusChange === change) target.focusChange = null;
      });
    target.focusChange = change;
  };

  const waitingHolds = (target: AttachedTarget) =>
    target.waitingScreenshots.some((waiting) => waiting.held && waiting.live());

  const releaseFocusWhenIdle = (target: AttachedTarget) => {
    if (target.focusReleasing) return;
    target.focusReleasing = true;
    runFork(
      Effect.gen(function* () {
        let uses: number;
        do {
          uses = target.focusUses;
          yield* Effect.sleep(FOCUS_IDLE);
        } while (uses !== target.focusUses);
        target.focusReleasing = false;
        // The last pending command to settle starts another idle wait.
        if (target.focusPending.size > 0 || target.screencasts.size > 0 || waitingHolds(target)) {
          return;
        }
        // The agent pauses to think between steps; its tab stays focused until the turn ends.
        if (target.agentUsed && agentTurns.has(target.tab.key.threadId)) return;
        target.agentUsed = false;
        if (isAttached(target)) setFocusEmulation(target, false);
      }),
    );
  };

  /**
   * Electron composites no offscreen guest, so its screenshot or screencast waits for a frame
   * that never comes. The client paints the guest behind the app while one is pending; the
   * capture then finishes on its own, and the guest goes back offscreen once none is.
   * A popup is a window of its own, which the client does not paint.
   */
  const syncPainting = (target: AttachedTarget) => {
    const tab = target.tab;
    if (target !== tab) return;
    const active =
      tabs.get(keyOf(tab.key)) === tab &&
      (tab.screencasts.size > 0 ||
        waitingHolds(tab) ||
        [...tab.focusPending.values()].some((hold) => hold.paints));
    if (tab.painting === active) return;
    tab.painting = active;
    runFork(PubSub.publish(painting, { key: tab.key, active }));
  };

  /** A command may wait on the page's next frame, so the guest stays focused until it settles. */
  const holdFocus = <A>(
    target: AttachedTarget,
    method: string,
    owner: string | undefined,
    work: () => Promise<A>,
  ) => {
    const pending = {};
    target.focusPending.set(pending, { owner, paints: method === "Page.captureScreenshot" });
    target.focusUses += 1;
    setFocusEmulation(target, true);
    releaseFocusWhenIdle(target);
    syncPainting(target);
    return work().finally(() => {
      if (!target.focusPending.delete(pending)) return;
      target.focusUses += 1;
      releaseFocusWhenIdle(target);
      syncPainting(target);
    });
  };

  /**
   * Chromium can leave a command unanswered, so the screenshot guard's release points
   * also end every hold: a released relay has no one waiting, and a new document answers
   * nothing pending from the old one. A released relay's screencast has no viewer to stop it.
   */
  const dropFocusHolds = (target: AttachedTarget) => {
    target.focusPending.clear();
    releaseFocusWhenIdle(target);
    syncPainting(target);
  };

  const dropRelay = (tab: AttachedTab) => {
    tab.relay = null;
    tab.showsPopups = false;
    for (const popup of tab.popups.values()) hidePopup(popup);
    tab.screencasts.clear();
    tab.agentUsed = false;
    dropFocusHolds(tab);
  };

  /** A detached session, such as a closed viewer, waits on nothing it sent. */
  const dropSessionHolds = (target: AttachedTarget, owner: string) => {
    target.screencasts.delete(owner);
    for (const [pending, hold] of target.focusPending) {
      if (hold.owner === owner) target.focusPending.delete(pending);
    }
    releaseFocusWhenIdle(target);
    syncPainting(target);
  };

  /**
   * A command the server stopped waiting on, such as a timed-out screenshot or evaluation,
   * may never settle; the turn's end ends every hold. The agent also sends on its own extra
   * session, so this cannot spare other sessions; a viewer's screencast still holds.
   */
  const endAgentTurn = (threadId: string) => {
    agentTurns.delete(threadId);
    for (const tab of tabs.values()) {
      if (tab.key.threadId !== threadId) continue;
      for (const target of [tab, ...tab.popups.values()]) {
        target.agentUsed = false;
        // Still sent in turn, so the queue keeps moving, but no longer kept painting.
        for (const waiting of target.waitingScreenshots) waiting.held = false;
        dropFocusHolds(target);
      }
    }
  };

  /** One relay drives the tab's page and its popups; each keeps its own focus and screenshots. */
  const relayTarget = (
    target: AttachedTarget,
    relay: () => CdpRelayConnection,
    owners: RelayOwners,
  ): CdpRelayTarget => {
    const { webContents, debugger: debuggee } = target.debuggee;
    const live = () => target.tab.relay === relay() && isAttached(target);
    const send = (method: string, params: Record<string, unknown>, sessionId?: string) =>
      sendPageCommand(webContents, debuggee, method, params, sessionId);
    return {
      send: (method, params, sessionId, owner) => {
        // A child session's screencast is not the page's, such as a late one on a detached session.
        if (sessionId === undefined && method === "Page.startScreencast") {
          target.screencasts.add(owner);
          if (owner !== undefined) owners.streaming.add(owner);
        } else if (sessionId === undefined && method === "Page.stopScreencast") {
          target.screencasts.delete(owner);
        }
        if (AGENT_INPUT_METHOD.test(method)) {
          target.agentInputAt = performance.now();
          // A person's input through a viewer, or Playwright's own housekeeping, is not the agent's.
          if (owner === undefined || !owners.streaming.has(owner)) target.agentUsed = true;
        }
        // Waits for focus emulation; insertText and other non-CDP input would not queue behind it.
        const forward = (current?: () => boolean) => {
          const change = target.focusChange;
          const run = () =>
            live() && (current === undefined || current())
              ? send(method, params, sessionId)
              : Promise.reject(new Error("The page this screenshot was for has moved on."));
          return change === null ? run() : change.then(run);
        };
        return method === "Page.captureScreenshot"
          ? takeScreenshot(
              target,
              relay(),
              () => owner === undefined || !owners.detached.has(owner),
              (current, held) =>
                held ? holdFocus(target, method, owner, () => forward(current)) : forward(current),
            )
          : method === "Page.startScreencast"
            ? holdFocus(target, method, owner, forward).catch((cause: unknown) => {
                // A viewer can outlive a refused stream; nothing is streaming for it.
                if (sessionId === undefined && live()) target.screencasts.delete(owner);
                releaseFocusWhenIdle(target);
                syncPainting(target);
                throw cause;
              })
            : holdFocus(target, method, owner, forward);
      },
      sessionDetached: (owner) => {
        owners.detached.add(owner);
        dropSessionHolds(target, owner);
      },
      targetId: () =>
        debuggee
          .sendCommand("Target.getTargetInfo")
          .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
      url: () => webContents.getURL(),
      title: () => webContents.getTitle(),
      userAgent: () => webContents.getUserAgent(),
      setDownloadDirectory: (directory) => {
        target.downloadDirectory = directory;
      },
      ...(target === target.tab
        ? {}
        : {
            close: () => {
              if (!webContents.isDestroyed()) webContents.close();
            },
          }),
    };
  };

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { debugger: debuggee } = tab.debuggee;
    tab.owners = { detached: new Set(), streaming: new Set() };
    const relay: CdpRelayConnection = createCdpRelayConnection(
      relayTarget(tab, () => relay, tab.owners),
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit({ type: "cdp", ...tab.key, message });
        }
      },
      // Announcing the tab again would reconnect Playwright, and the page could
      // replay the same oversized event, so the tab stays detached.
      () => {
        if (tab.relay !== relay || tabs.get(keyOf(tab.key)) !== tab) return;
        // Disabling auto-attach detaches child sessions and releases their debugger pauses.
        void debuggee
          .sendCommand("Target.setAutoAttach", {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          })
          .catch(() => {});
        if (tab.screencasts.size > 0) {
          void debuggee.sendCommand("Page.stopScreencast").catch(() => {});
        }
        setFocusEmulation(tab, false);
        detach(tab.key);
      },
    );
    tab.relay = relay;
    showPopups(tab);
    return relay;
  };

  const freshTarget = (debuggee: DesktopBrowserTabDebugger) => ({
    debuggee,
    screenshotTurn: null,
    waitingScreenshots: [],
    downloadDirectory: null,
    pendingDownloadGuid: null,
    agentInputAt: Number.NEGATIVE_INFINITY,
    focusEmulated: false,
    focusChange: null,
    focusUses: 0,
    focusPending: new Map(),
    agentUsed: false,
    focusReleasing: false,
    screencasts: new Set<string | undefined>(),
  });

  const listen = <T extends Omit<AttachedTarget, "onMessage" | "onNewDocument">>(
    target: T,
    relayed: () => { readonly event: CdpRelayConnection["event"] } | null,
  ): T & Pick<AttachedTarget, "onMessage" | "onNewDocument"> =>
    Object.assign(target, {
      onMessage: (_event: Electron.Event, method: string, params: unknown, sessionId: string) => {
        if (method === "Page.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          target.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        relayed()?.event(method, params, sessionId);
      },
      // A screenshot pending when the page loads a new document, a reload included, can
      // stay unanswered. A crashed page lands here once it reloads, well after its renderer died.
      onNewDocument: () => {
        const listening = target as T & AttachedTarget;
        // Before the next screenshot starts, so its own hold survives.
        dropFocusHolds(listening);
        if (listening.screenshotTurn !== null) nextScreenshot(listening);
      },
    });

  const showPopup = (tab: AttachedTab, webContents: Electron.WebContents) => {
    const relay = tab.relay;
    if (!relay || !tab.showsPopups || tab.popups.has(webContents) || webContents.isDestroyed())
      return;
    // Kept for the popup's lifetime; `webContents.debugger` throws once it is destroyed.
    const debuggee = webContents.debugger;
    if (webContents.isDevToolsOpened() || debuggee.isAttached()) return;
    try {
      debuggee.attach("1.3");
    } catch {
      return;
    }
    const popup: AttachedPopup = listen(
      {
        ...freshTarget({ webContents, debugger: debuggee }),
        tab,
        relayed: null,
        onDetach: () => hidePopup(popup, true),
      },
      () => popup.relayed,
    );
    tab.popups.set(webContents, popup);
    debuggee.on("message", popup.onMessage);
    debuggee.on("detach", popup.onDetach);
    webContents.on("did-navigate", popup.onNewDocument);
    popup.relayed = relay.addPopup(relayTarget(popup, () => relay, tab.owners));
  };

  /** Detaching the debugger also ends the popup's streams, emulation and paused children. */
  const hidePopup = (popup: AttachedPopup, debuggerGone = false) => {
    const { tab, debuggee } = popup;
    if (tab.popups.get(debuggee.webContents) !== popup) return;
    tab.popups.delete(debuggee.webContents);
    debuggee.debugger.off("message", popup.onMessage);
    debuggee.debugger.off("detach", popup.onDetach);
    debuggee.webContents.off("did-navigate", popup.onNewDocument);
    popup.relayed?.remove();
    popup.screencasts.clear();
    dropFocusHolds(popup);
    if (!debuggerGone && !debuggee.webContents.isDestroyed() && debuggee.debugger.isAttached()) {
      debuggee.debugger.detach();
    }
  };

  const showPopups = (tab: AttachedTab) => {
    for (const popup of openedPopups.get(tab.debuggee.webContents) ?? []) showPopup(tab, popup);
  };

  const openedPopup = (opener: Electron.WebContents, popup: Electron.WebContents) => {
    if (popup.isDestroyed()) return;
    const popups = openedPopups.get(opener) ?? new Set();
    if (popups.has(popup)) return;
    openedPopups.set(opener, popups);
    popups.add(popup);
    const show = () => {
      for (const tab of tabs.values())
        if (tab.debuggee.webContents === opener) showPopup(tab, popup);
    };
    const report = (open: boolean) => {
      for (const tab of tabs.values()) {
        // A tab still waiting for its first page reports them when it is announced.
        if (tab.debuggee.webContents === opener && tab.stopWaiting === null) {
          emit({ type: "popupWindows", ...tab.key, open });
        }
      }
    };
    popup.on("devtools-closed", show);
    if (popups.size === 1) report(true);
    popup.once("destroyed", () => {
      popup.off("devtools-closed", show);
      popups.delete(popup);
      if (popups.size === 0 && openedPopups.get(opener) === popups) openedPopups.delete(opener);
      if (popups.size === 0) report(false);
      for (const tab of tabs.values()) {
        const shown = tab.popups.get(popup);
        if (shown) hidePopup(shown, true);
      }
    });
    show();
  };

  const targetOf = (source: Electron.WebContents) => {
    for (const tab of tabs.values()) {
      if (tab.debuggee.webContents === source) return tab;
      const popup = tab.popups.get(source);
      if (popup) return popup;
    }
    return undefined;
  };

  // CDP supplies the path before this runs; otherwise Electron opens a Save dialog.
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    const target = targetOf(source);
    if (!target?.downloadDirectory || !target.pendingDownloadGuid) return false;
    item.setSavePath(NodePath.join(target.downloadDirectory, target.pendingDownloadGuid));
    target.pendingDownloadGuid = null;
    return true;
  };

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    for (const popup of tab.popups.values()) hidePopup(popup);
    tabs.delete(id);
    const announced = tab.stopWaiting === null;
    tab.stopWaiting?.();
    tab.relay = null;
    tab.debuggee.debugger.off("message", tab.onMessage);
    tab.debuggee.webContents.off("did-navigate", tab.onNewDocument);
    syncPainting(tab);
    if (announced) emit({ type: "detached", ...key });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = listen(
      {
        ...freshTarget(debuggee),
        get tab() {
          return tab;
        },
        key,
        relay: null,
        owners: { detached: new Set(), streaming: new Set() },
        painting: false,
        showsPopups: false,
        popups: new Map(),
        stopWaiting: null,
      },
      () => tab.relay,
    );
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    debuggee.webContents.on("did-navigate", tab.onNewDocument);
    const announce = () => {
      emit({ type: "attached", ...key });
      if (openedPopups.get(debuggee.webContents)?.size) {
        emit({ type: "popupWindows", ...key, open: true });
      }
      const shown = shownTabs.get(id);
      if (shown !== undefined) emit({ type: "shown", ...key, shown });
    };
    if (!debuggee.webContents.isLoadingMainFrame()) {
      announce();
      return;
    }
    // Electron does not pause a guest for the debugger, so Playwright connecting during its first
    // commit builds its utility world in the discarded document and every wait on it hangs.
    const { webContents } = debuggee;
    // ERR_ABORTED is a newer navigation replacing this one, whose commit is still to come.
    const onFailLoad = (
      _event: Electron.Event,
      code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && code !== ERR_ABORTED) ready();
    };
    const ready = () => {
      if (tab.stopWaiting === null) return;
      // The manager's cleanup for a destroyed guest can still be queued behind another tab's attach.
      if (webContents.isDestroyed()) return detach(key);
      tab.stopWaiting();
      announce();
    };
    const timeout = runFork(
      Effect.sleep(FIRST_PAGE_TIMEOUT).pipe(Effect.andThen(Effect.sync(ready))),
    );
    tab.stopWaiting = () => {
      tab.stopWaiting = null;
      webContents.off("dom-ready", ready);
      webContents.off("did-stop-loading", ready);
      webContents.off("did-fail-load", onFailLoad);
      runFork(Fiber.interrupt(timeout));
    };
    webContents.on("dom-ready", ready);
    webContents.on("did-stop-loading", ready);
    webContents.on("did-fail-load", onFailLoad);
  };

  const setShown = (key: DesktopBrowserTabKey, shown: boolean | undefined) => {
    const id = keyOf(key);
    if (shown === undefined) {
      shownTabs.delete(id);
      return;
    }
    if (shownTabs.get(id) === shown) return;
    shownTabs.set(id, shown);
    if (tabs.get(id)?.stopWaiting === null) emit({ type: "shown", ...key, shown });
  };

  const handleCommandLine = (line: string) =>
    Effect.sync(() => {
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      if (command.value.type === "turn") {
        if (command.value.active) agentTurns.add(command.value.threadId);
        else endAgentTurn(command.value.threadId);
        return;
      }
      const tab = tabs.get(keyOf(command.value));
      if (!tab) return;
      switch (command.value.type) {
        case "pointer": {
          const { threadId, tabId, phase, x, y } = command.value;
          runFork(PubSub.publish(pointers, { key: { threadId, tabId }, phase, x, y }));
          return;
        }
        case "release":
          dropRelay(tab);
          return;
        case "popups":
          tab.showsPopups = true;
          if (tab.relay) showPopups(tab);
          return;
        case "cdp":
          relayFor(tab).receive(command.value.message);
      }
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const target = targetOf(source);
    return (
      target !== undefined && performance.now() - target.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS
    );
  };

  const announceAll = Effect.suspend(() => {
    // A new backend: the old one's turns ended without telling us.
    agentTurns.clear();
    return Effect.forEach(
      [...tabs.values()],
      (tab) => {
        dropRelay(tab);
        // Announced once its first page is up.
        if (tab.stopWaiting !== null) return Effect.void;
        const shown = shownTabs.get(keyOf(tab.key));
        return PubSub.publish(outbox, { type: "attached", ...tab.key }).pipe(
          Effect.andThen(
            openedPopups.get(tab.debuggee.webContents)?.size
              ? PubSub.publish(outbox, { type: "popupWindows", ...tab.key, open: true })
              : Effect.void,
          ),
          Effect.andThen(
            shown !== undefined
              ? PubSub.publish(outbox, { type: "shown", ...tab.key, shown })
              : Effect.void,
          ),
        );
      },
      { discard: true },
    );
  });

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    painting: Stream.fromPubSub(painting),
    // Subscribes before announcing, so no attach falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* announceAll;
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(Stream.map((event) => lineEncoder.encode(`${encodeEvent(event)}\n`))),
    handleCommandLine,
    attach,
    detach,
    openedPopup,
    setShown,
    placeDownload,
    humanStartedDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
