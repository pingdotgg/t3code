// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
// Screencasts ignore emulated device scale; real 2x keeps captures sharp.
// --disable-gpu uses cheaper software compositing while preserving SwiftShader WebGL.
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  FILL_PREVIEW_VIEWPORT,
  findBrowserProfile,
  INCOGNITO_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
  type PreviewReportProfilesInput,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PreviewViewportSetting as PreviewViewportSettingSchema,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationActionEvent,
  type PreviewAutomationClickInput,
  type PreviewAutomationDialogInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
  PreviewClearProfileError,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  ThreadId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type PreviewAppearancePreference,
} from "@t3tools/contracts";
import { AgentScope, agentScopeLauncherScript } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Frame,
  Page,
} from "playwright-core";

import { PENDING_ATTACHMENT_THREAD_SEGMENT } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewManager from "./Manager.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";
import { installPdfDocumentNavigation, isPdfAssetUrl } from "./PdfDocumentNavigation.ts";
import type { EncoderWindow, Recording, ServerDownload, ServerTab, ViewerState } from "./ServerBrowser-part2.ts";
import { ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS, AGENT_TAB_IDLE_MS, AGENT_TAB_LIMIT, CLIPBOARD_SCRIPT, CLIPBOARD_WORLD, DOWNLOAD_LIMIT, DOWNLOAD_MAX_BYTES, IDLE_SWEEP_INTERVAL, READ_OPERATIONS, SERVER_TAB_LIMIT, asRecord, editingCommand, fixedViewportSize, modifiersOf, num, pushBounded, tabKey, viewportSettingsEqual } from "./ServerBrowser-part2.ts";
import type { ProfileReporter, ServerBrowserViewer, ServerBrowserViewerOutput } from "./ServerBrowser-part3.ts";
import { ACTION_TIMELINE_LIMIT, AGENT_CURSOR_CLICK_LEAD_MS, AGENT_CURSOR_MOVE_MS, DESKTOP_ATTACH_TIMEOUT, DESKTOP_VIEWPORT_READ_TIMEOUT, EDITABLE_AT_POINT_SCRIPT, HOST_RECONNECT_DELAY, NAVIGATION_TIMEOUT_MS, RECORDING_SCREENCAST, RENDER_SCALE, SCREENCAST_ACK_PACE_MS, SCREENCAST_MOTION_FRAMES, SCREENCAST_MOTION_QUALITY, SCREENCAST_MOTION_WINDOW_MS, SCREENCAST_SETTLE_MS, SERVER_HOST_CLIENT_ID, ServerBrowserLaunchError, ServerBrowserTabNotFoundError, UNATTACHED_FILL_VIEWPORT, VIEWER_NAVIGATION_OPTIONS, VIEWER_OUTPUT_LIMIT, decodeViewportSetting, isHostSetupError, isTabNotFound, sleepUntil } from "./ServerBrowser-part3.ts";
import type { ServerBrowser } from "./ServerBrowser.ts";

type PreviewManagerService = PreviewManager.PreviewManager["Service"];

export interface ServerBrowserViewerDeps {
  readonly tabs: Map<string, ServerTab>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E, never>) => unknown;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  readonly manager: PreviewManagerService;
  readonly findTab: (
    threadId: string,
    tabId: string,
  ) => Effect.Effect<ServerTab, ServerBrowserTabNotFoundError | ServerBrowserLaunchError>;
  readonly reportLiveTabs: () => void;
  readonly broadcastControl: (tab: ServerTab) => void;
  readonly pushFileChooser: (tab: ServerTab) => void;
  readonly withCaptureLock: <A>(tab: ServerTab, operation: () => Promise<A>) => Promise<A>;
  readonly resolveDialog: (tab: ServerTab, input: PreviewAutomationDialogInput) => Promise<void>;
  readonly applySetting: (tab: ServerTab, setting: PreviewViewportSetting) => Promise<void>;
  readonly broadcastViewport: (tab: ServerTab) => Promise<void>;
  readonly takeCopiedText: (tab: ServerTab) => Promise<string | undefined>;
}

export const createServerBrowserViewer = (deps: ServerBrowserViewerDeps) => {
  let viewerResizeOrder = 0;
  const { tabs, runFork, runPromise, manager, findTab, reportLiveTabs, broadcastControl, pushFileChooser, withCaptureLock, resolveDialog, applySetting, broadcastViewport, takeCopiedText } = deps;

  const releaseViewerInput = async (viewer: ViewerState, session: CDPSession) => {
    for (const { key, code } of viewer.pressedKeys.values()) {
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code }).catch(constVoid);
    }
    viewer.pressedKeys.clear();
    for (const [button, point] of viewer.pressedButtons) {
      await session
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button,
          ...point,
          buttons: 0,
          clickCount: 1,
        })
        .catch(constVoid);
    }
    viewer.pressedButtons.clear();
    viewer.requestedSize = null;
  };

  const dispatchViewerInput = async (
    tab: ServerTab,
    session: CDPSession,
    viewer: ViewerState,
    raw: unknown,
  ) => {
    const message = asRecord(raw);
    if (!message) return;
    const modifiers = modifiersOf(message);
    switch (message.type) {
      case "mouse": {
        const action = message.action;
        const type =
          action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved";
        const button = ["none", "left", "middle", "right"].includes(String(message.button))
          ? (message.button as "none" | "left" | "middle" | "right")
          : "none";
        await session.send("Input.dispatchMouseEvent", {
          type,
          x: num(message.x),
          y: num(message.y),
          button,
          buttons: num(message.buttons),
          clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
          modifiers,
        });
        if (button !== "none") {
          if (action === "down")
            viewer.pressedButtons.set(button, { x: num(message.x), y: num(message.y) });
          else if (action === "up") viewer.pressedButtons.delete(button);
        }
        return;
      }
      case "wheel":
        viewer.scrolledAt = Date.now();
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: num(message.x),
          y: num(message.y),
          deltaX: num(message.deltaX),
          deltaY: num(message.deltaY),
          modifiers,
        });
        return;
      case "key": {
        const key = typeof message.key === "string" ? message.key : "";
        const code = typeof message.code === "string" ? message.code : "";
        const text = typeof message.text === "string" ? message.text : undefined;
        if (message.action === "up") {
          await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
          viewer.pressedKeys.delete(code || key);
          return;
        }
        const command = editingCommand(key, modifiers);
        const copying =
          !tab.desktop && (command?.commands[0] === "copy" || command?.commands[0] === "cut");

        if (copying) await takeCopiedText(tab);
        await session.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key,
          code,
          modifiers,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...command,
          windowsVirtualKeyCode: num(
            message.keyCode,
            key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
          ),
        });
        viewer.pressedKeys.set(code || key, { key, code });
        if (copying) {
          const copied = await takeCopiedText(tab);
          if (copied) viewer.push({ _tag: "clipboard", text: copied });
        }
        return;
      }
      case "text":
        if (typeof message.text === "string" && message.text.length > 0) {
          await session.send("Input.insertText", { text: message.text.slice(0, 10_000) });
        }
        return;
      case "resize": {
        const width = Math.min(Math.round(num(message.width)), 3840);
        const height = Math.min(Math.round(num(message.height)), 2160);
        if (width < 100 || height < 100) return;
        viewer.requestedSize = { width, height, order: ++viewerResizeOrder };
        if (tab.setting._tag !== "fill" || tab.desktop) return;
        const current = tab.page.viewportSize();
        if (current?.width === width && current.height === height) return;
        await tab.page.setViewportSize({ width, height });
        await broadcastViewport(tab);
        return;
      }
      case "viewport": {
        const setting = decodeViewportSetting(message.setting);
        await runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return;
      }
      // A stalled navigation must not block a corrected URL or further viewer input.
      case "navigate":
        if (typeof message.url === "string") {
          const url = normalizePreviewUrl(message.url);
          tab.control.trackUntilHandoff(tab.page.goto(url, VIEWER_NAVIGATION_OPTIONS));
        }
        return;
      case "history":
        tab.control.trackUntilHandoff(
          num(message.delta) < 0
            ? tab.page.goBack(VIEWER_NAVIGATION_OPTIONS)
            : tab.page.goForward(VIEWER_NAVIGATION_OPTIONS),
        );
        return;
      case "reload":
        if (message.ignoreCache === true) {
          await session.send("Page.reload", { ignoreCache: true });
          return;
        }
        tab.control.trackUntilHandoff(tab.page.reload(VIEWER_NAVIGATION_OPTIONS));
        return;
      case "probe": {
        const x = num(message.x);
        const y = num(message.y);
        const result = await session.send("Runtime.evaluate", {
          expression: `(${EDITABLE_AT_POINT_SCRIPT})(${x}, ${y})`,
          returnByValue: true,
        });
        viewer.push({ _tag: "probe", x, y, editable: result.result.value === true });
        return;
      }
    }
  };

  const attachViewer: ServerBrowser["Service"]["attachViewer"] = Effect.fn(
    "ServerBrowser.attachViewer",
  )(function* (input) {
    const tab = yield* findTab(input.threadId, input.tabId);
    const output = yield* Queue.make<ServerBrowserViewerOutput>({
      capacity: VIEWER_OUTPUT_LIMIT,
      strategy: "dropping",
    });
    const session = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => tab.page.context().newCDPSession(tab.page),
        catch: (cause) => new ServerBrowserLaunchError({ cause }),
      }),
      (session) =>
        Effect.promise(() =>
          session
            .send("Page.stopScreencast")
            .catch(constVoid)
            .then(() => session.detach())
            .catch(constVoid),
        ),
    );
    const quality = Math.min(100, Math.max(1, Math.round(input.quality)));
    // Chromium may drop the final frame during a burst; send a still when it settles.
    let framesInFlight = 0;
    let mayHaveDropped = false;
    let motion = false;
    const recentFrames: Array<number> = [];
    let screencastParams = Promise.resolve();
    let screencastScale = 1;
    const startScreencast = (scale: number) => {
      screencastScale = scale;
      screencastParams = screencastParams.then(async () => {
        if (tab.capturing > 0) return;
        await session.send("Page.stopScreencast").catch(constVoid);
        await session
          .send("Page.startScreencast", {
            format: "jpeg",
            quality: screencastScale < 1 ? Math.min(quality, SCREENCAST_MOTION_QUALITY) : quality,
            maxWidth: Math.max(1, Math.round(input.maxWidth * screencastScale)),
            maxHeight: Math.max(1, Math.round(input.maxHeight * screencastScale)),
          })
          .catch(constVoid);
      });
      return screencastParams;
    };
    const viewer: ViewerState = {
      id: NodeCrypto.randomUUID(),
      canOperate: input.canOperate,
      pressedKeys: new Map(),
      pressedButtons: new Map(),
      push: (next) => {
        // Dropped frames must still release Chromium.
        if (Queue.offerUnsafe(output, next)) return;
        if (next._tag === "frame") runFork(next.ack);
        // State a stalled viewer cannot miss compacts its backlog. It runs
        // synchronously so an older compaction can never land after a newer one.
        else if (["gone", "reconnect", "control", "viewport", "fileChooser"].includes(next._tag)) {
          const dropped = Effect.runSyncExit(Queue.clear(output));
          if (dropped._tag === "Failure") return;
          const items = [...dropped.value, next];
          // Without its latest size and control the viewer cannot map input at all.
          const state = (["control", "viewport"] as const).flatMap(
            (tag) => items.findLast((item) => item._tag === tag) ?? [],
          );
          // Everything else is one-time; if it no longer fits, the oldest goes first.
          const rest = items.filter(
            (item) => item._tag !== "frame" && item._tag !== "control" && item._tag !== "viewport",
          );
          for (const item of [...rest.slice(state.length - VIEWER_OUTPUT_LIMIT), ...state])
            Queue.offerUnsafe(output, item);
          for (const item of dropped.value) if (item._tag === "frame") runFork(item.ack);
        }
      },
      pause: () => {
        screencastParams = screencastParams.then(() =>
          session.send("Page.stopScreencast").then(constVoid, constVoid),
        );
        return screencastParams;
      },
      resume: () => startScreencast(screencastScale),
      scrolledAt: 0,
      requestedSize: null,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        tab.viewers.add(viewer);
        reportLiveTabs();
      }),
      () =>
        Effect.promise(async () => {
          await tab.control.disconnect(viewer.id, () => releaseViewerInput(viewer, session));
          tab.viewers.delete(viewer);
          broadcastControl(tab);
          reportLiveTabs();
        }),
    );
    if (input.canOperate && tab.control.agentId === null && tab.control.controller === null) {
      yield* Effect.promise(() => tab.control.take(viewer.id));
    }
    broadcastControl(tab);
    pushFileChooser(tab);
    const pushStill = async () => {
      const data = await withCaptureLock(tab, () =>
        ServerBrowserPage.captureViewport(session, { format: "jpeg", quality }),
      ).catch(() => null);
      if (data) viewer.push({ _tag: "frame", data: Buffer.from(data, "base64"), ack: Effect.void });
    };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (settleTimer !== null) clearTimeout(settleTimer);
      }),
    );
    let screencastStarted = false;
    session.on("Page.screencastFrame", (frame) => {
      screencastStarted = true;
      if (framesInFlight > 0) mayHaveDropped = true;
      framesInFlight += 1;
      const arrivedAt = Date.now();
      recentFrames.push(arrivedAt);
      while (recentFrames[0]! < arrivedAt - SCREENCAST_MOTION_WINDOW_MS) recentFrames.shift();
      if (
        !motion &&
        recentFrames.length >= SCREENCAST_MOTION_FRAMES &&
        arrivedAt - viewer.scrolledAt < SCREENCAST_MOTION_WINDOW_MS
      ) {
        motion = true;
        void startScreencast(0.5);
      } else if (motion && arrivedAt - viewer.scrolledAt > SCREENCAST_SETTLE_MS) {
        motion = false;
        recentFrames.length = 0;
        void startScreencast(1);
      }
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!motion && !mayHaveDropped) return;
        mayHaveDropped = false;
        if (motion) {
          motion = false;
          recentFrames.length = 0;
          void startScreencast(1);
        }
        void pushStill();
      }, SCREENCAST_SETTLE_MS);
      viewer.push({
        _tag: "frame",
        data: Buffer.from(frame.data, "base64"),
        ack: Effect.promise(() =>
          sleepUntil(arrivedAt + SCREENCAST_ACK_PACE_MS).then(() => {
            framesInFlight -= 1;
            return session
              .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
              .catch(constVoid);
          }),
        ),
      });
    });
    void broadcastViewport(tab).catch(constVoid);
    yield* Effect.promise(() => startScreencast(1));
    // An idle page does not repaint for a new screencast, so the viewer
    // starts from a still unless a live frame beat it.
    if (!screencastStarted) yield* Effect.promise(pushStill);
    return {
      output,
      input: (raw: unknown) =>
        Effect.promise(async () => {
          if (!viewer.canOperate) return;
          const message = asRecord(raw);
          if (!message) return;
          try {
            if (message.type === "takeControl") {
              const taking = tab.control.take(viewer.id);
              broadcastControl(tab);
              await taking;
              pushFileChooser(tab);
            } else if (message.type === "releaseControl") {
              const releasing = tab.control.release(viewer.id, () =>
                releaseViewerInput(viewer, session),
              );
              broadcastControl(tab);
              await releasing;
            } else if (
              message.type === "dialog" &&
              tab.control.controller === viewer.id &&
              typeof message.accept === "boolean"
            ) {
              await resolveDialog(tab, {
                accept: message.accept,
                ...(typeof message.promptText === "string"
                  ? { promptText: message.promptText }
                  : {}),
              });
            } else {
              const dispatch = (input: Record<string, unknown>) =>
                dispatchViewerInput(tab, session, viewer, input);
              if (
                message.type === "mouse" &&
                message.action === "move" &&
                message.button === "none" &&
                message.buttons === 0
              ) {
                await tab.control.humanLatest(
                  viewer.id,
                  `hover:${modifiersOf(message)}`,
                  message,
                  dispatch,
                );
              } else if (message.type === "wheel") {
                // A reversal stays separate so scrolling clamped at an edge behaves as if unmerged.
                await tab.control.humanLatest(
                  viewer.id,
                  `wheel:${num(message.x)}:${num(message.y)}:${modifiersOf(message)}:${Math.sign(num(message.deltaX))}:${Math.sign(num(message.deltaY))}`,
                  message,
                  dispatch,
                  (waiting, next) => ({
                    ...next,
                    deltaX: num(waiting.deltaX) + num(next.deltaX),
                    deltaY: num(waiting.deltaY) + num(next.deltaY),
                  }),
                );
              } else {
                await tab.control.human(viewer.id, () => dispatch(message));
              }
            }
          } catch {
            broadcastControl(tab);
          }
        }),
    } satisfies ServerBrowserViewer;
  });

  return { attachViewer, releaseViewerInput, dispatchViewerInput };
};
