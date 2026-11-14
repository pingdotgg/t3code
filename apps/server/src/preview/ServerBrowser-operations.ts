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

export interface ServerBrowserOperationsDeps {
  readonly tabs: Map<string, ServerTab>;
  readonly tabKey: (threadId: string, tabId: string) => string;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E, never>) => unknown;
  readonly manager: PreviewManagerService;
  readonly desktopChannel: DesktopBrowserChannel.DesktopBrowserChannel["Service"];
  readonly READ_OPERATIONS: ReadonlySet<string>;
  readonly findTab: (
    threadId: string,
    tabId: string,
  ) => Effect.Effect<ServerTab, ServerBrowserTabNotFoundError | ServerBrowserLaunchError>;
  readonly latestThreadTab: (threadId: string, agentSessionId?: string) => ServerTab | undefined;
  readonly closeIdleAgentTabs: () => void;
  readonly openTab: (
    input: Parameters<PreviewManagerService["open"]>[0],
  ) => Effect.Effect<
    ServerTab,
    Effect.Error<ReturnType<PreviewManagerService["open"]>> | ServerBrowserPage.ServerBrowserOperationError
  >;
  readonly dropTab: (tab: ServerTab, closeSession: boolean) => void;
  readonly applySetting: (tab: ServerTab, setting: PreviewViewportSetting) => Promise<void>;
  readonly applyRendering: (tab: ServerTab, snapshot: PreviewSessionSnapshot) => Promise<void>;
  readonly statusWithTitle: (
    tab: ServerTab | undefined,
    agentSessionId?: string,
  ) => Promise<PreviewAutomationStatus>;
  readonly resolveOpenProfile: (requested: string | undefined) => string | undefined;
  readonly resolveNavigationUrl: (input: PreviewAutomationNavigateInput) => string;
  readonly navigate: (
    tab: ServerTab,
    url: string,
    readiness: "load" | "domContentLoaded" | "none",
    timeout: number,
  ) => Promise<void>;
  readonly withScreencastsPaused: <A>(tab: ServerTab, capture: () => Promise<A>) => Promise<A>;
  readonly startRecording: (tab: ServerTab) => Promise<Recording>;
  readonly stopRecording: (tab: ServerTab) => Promise<unknown>;
  readonly uploadFiles: (tab: ServerTab, input: PreviewAutomationUploadInput) => Promise<void>;
  readonly resolveDialog: (tab: ServerTab, input: PreviewAutomationDialogInput) => Promise<void>;
  readonly updateFileChooserInterception: (tab: ServerTab) => void;
}

export const createServerBrowserOperations = (deps: ServerBrowserOperationsDeps) => {
  const { tabs, tabKey, runPromise, runFork, manager, desktopChannel, READ_OPERATIONS,
    findTab, latestThreadTab, closeIdleAgentTabs, openTab, dropTab, applySetting, applyRendering,
    statusWithTitle, resolveOpenProfile, resolveNavigationUrl, navigate,
    withScreencastsPaused, startRecording, stopRecording, uploadFiles,
    resolveDialog, updateFileChooserInterception } = deps;

  let pointerSequence = 0;
  const pointerFor =
    (tab: ServerTab): ServerBrowserPage.PointerReporter =>
    async ({ x, y }, phase) => {
      const encoder = tab.recording?.encoder;

      if (tab.viewers.size === 0 && !encoder && !tab.desktop) return;
      const show = (next: "move" | "click") => {
        const sequence = ++pointerSequence;
        for (const viewer of tab.viewers)
          viewer.push({ _tag: "pointer", phase: next, x, y, sequence });
        if (tab.desktop)
          runFork(
            desktopChannel.pointer(
              { threadId: tab.threadId, tabId: tab.tabId },
              { phase: next, x, y },
            ),
          );
        void encoder
          ?.evaluate(
            ([px, py, click]) =>
              (globalThis as unknown as EncoderWindow).__t3Recorder?.cursor(px, py, click),
            [x, y, next === "click"] as const,
          )
          .catch(constVoid);
      };
      show("move");
      await sleepUntil(Date.now() + AGENT_CURSOR_MOVE_MS);
      if (phase !== "click") return;
      show("click");
      await sleepUntil(Date.now() + AGENT_CURSOR_CLICK_LEAD_MS);
    };

  const recordAction = <A>(tab: ServerTab, action: string, run: () => Promise<A>): Promise<A> => {
    const event: {
      -readonly [K in keyof PreviewAutomationActionEvent]: PreviewAutomationActionEvent[K];
    } = {
      id: NodeCrypto.randomUUID(),
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    pushBounded(tab.actionTimeline, event, ACTION_TIMELINE_LIMIT);
    return run().then(
      (result) => {
        event.status = "succeeded";
        event.completedAt = new Date().toISOString();
        return result;
      },
      (cause: unknown) => {
        event.status = "failed";
        event.completedAt = new Date().toISOString();
        event.error = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
        throw cause;
      },
    );
  };

  const requireTab = async (request: PreviewAutomationRequest) => {
    if (!request.agentSessionId)
      throw new BrowserControlInterrupted("The agent session is missing. Reconnect the provider.");
    const owned = [...tabs.values()].filter(
      (tab) => tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
    );
    if (!request.tabIdExplicit && owned.length > 1)
      throw new BrowserControlInterrupted(
        "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
        "tabRequired",
      );
    const tab =
      request.tabId === undefined
        ? latestThreadTab(request.threadId, request.agentSessionId)
        : await runPromise(
            findTab(request.threadId, request.tabId).pipe(Effect.orElseSucceed(constVoid)),
          );
    if (!tab) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationTabNotFoundError",
        "No server preview tab is open for this thread. Call preview_open first.",
      );
    }
    if (!READ_OPERATIONS.has(request.operation) && !tab.control.agentMayAct(request.agentSessionId))
      throw new BrowserControlInterrupted(
        "This tab belongs to another agent session. You can read it, but open your own tab to act.",
        "agentMismatch",
      );
    return tab;
  };

  const markUsed = (request: PreviewAutomationRequest) => {
    const now = Date.now();
    for (const tab of tabs.values()) {
      if (
        tab.threadId === request.threadId &&
        (tab.control.agentId === request.agentSessionId || tab.tabId === request.tabId)
      )
        tab.usedAt = now;
    }
  };

  const runOperation = async (
    request: PreviewAutomationRequest,
    deadlineMs: number,
  ): Promise<unknown> => {
    const input = request.input;
    switch (request.operation) {
      case "status":
        return statusWithTitle(
          request.tabId === undefined
            ? latestThreadTab(request.threadId, request.agentSessionId)
            : tabs.get(tabKey(request.threadId, request.tabId)),
          request.agentSessionId,
        );
      case "open": {
        if (!request.agentSessionId)
          throw new BrowserControlInterrupted(
            "The agent session is missing. Reconnect the provider.",
          );
        const open = input as PreviewAutomationOpenInput;
        const url = open.url === undefined ? undefined : normalizePreviewUrl(open.url);
        const reuse = open.reuseExistingTab ?? true;
        if (
          reuse &&
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (tab) =>
              tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted(
            "Multiple tabs are open. Pass tabId or reuseExistingTab=false.",
            "tabRequired",
          );

        const found =
          reuse && request.tabId !== undefined
            ? await runPromise(
                findTab(request.threadId, request.tabId).pipe(
                  Effect.catchTags({
                    ServerBrowserTabNotFoundError: () => Effect.void,
                  }),
                ),
              )
            : undefined;
        if (reuse && request.tabIdExplicit && !found) {
          const { sessions } = await runPromise(
            manager.list({ threadId: ThreadId.make(request.threadId) }),
          );
          const desktop = sessions.some(
            (session) => session.tabId === request.tabId && session.runtime !== "server",
          );
          throw new ServerBrowserPage.ServerBrowserOperationError(
            desktop ? "PreviewAutomationExecutionError" : "PreviewAutomationTabNotFoundError",
            desktop
              ? "This tab belongs to the desktop runtime. This environment's server browser cannot control desktop tabs. Omit tabId to open a server tab instead."
              : "The requested server preview tab does not exist.",
          );
        }
        // Reusing another session's tab requires explicit tabId; reading it grants no implicit takeover.
        const existing =
          found && (request.tabIdExplicit || found.control.agentId === request.agentSessionId)
            ? found
            : undefined;
        const navigationTimeout = Math.min(request.timeoutMs, NAVIGATION_TIMEOUT_MS);
        const profileId = existing ? undefined : resolveOpenProfile(open.profileId);
        if (!existing) closeIdleAgentTabs();
        const tab =
          existing ??
          (await runPromise(
            openTab({
              threadId: request.threadId,
              ...(url ? { url } : {}),
              ...(profileId === undefined ? {} : { profileId }),
              runtime: "server",
              reveal: false,
              automationOwner: request.agentSessionId,
            }),
          ));
        if (existing?.dialog)
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status and use preview_dialog first.",
            "dialogPending",
          );
        return tab.control.agent(
          request.agentSessionId,
          async () => {
            if (tab.dialog)
              throw new BrowserControlInterrupted(
                "A browser dialog is pending. Read preview_status and use preview_dialog first.",
                "dialogPending",
              );
            if (existing) {
              if (url) await navigate(tab, url, "load", navigationTimeout);
            } else {
              // A failed open returns no tabId; a leftover hidden tab would block later reuse.
              await tab.initialNavigation?.catch(async (cause: unknown) => {
                // Playwright rejects downloads too; their tab must survive to save the file.
                if (cause instanceof Error && cause.message.includes("Download is starting")) {
                  throw cause;
                }
                await runPromise(manager.close({ threadId: tab.threadId, tabId: tab.tabId }));
                dropTab(tab, false);
                throw cause;
              });
            }
            const reveal = open.open ?? open.show;
            if (reveal !== false) {
              await runPromise(
                manager.requestReveal({
                  threadId: tab.threadId,
                  tabId: tab.tabId,
                  force: reveal === true,
                }),
              );
            }
            if (!existing && url) {
              await tab.page
                .waitForLoadState("load", { timeout: navigationTimeout })
                .catch(constVoid);
            }
            return statusWithTitle(tab, request.agentSessionId);
          },
          deadlineMs,
        );
      }
      case "recordingStop": {
        if (
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (candidate) =>
              candidate.threadId === request.threadId &&
              candidate.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted(
            "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
            "tabRequired",
          );
        const recordings = [...tabs.values()].filter(
          (candidate) =>
            candidate.threadId === request.threadId &&
            candidate.control.agentMayAct(request.agentSessionId ?? "") &&
            (candidate.recording || candidate.recordingStart),
        );
        const targetTabId =
          request.tabId ?? latestThreadTab(request.threadId, request.agentSessionId)?.tabId;
        const tab =
          recordings.find((candidate) => candidate.tabId === targetTabId) ??
          (!request.tabIdExplicit && recordings.length === 1 ? recordings[0] : undefined);
        if (!tab) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingNotActiveError",
            "No recording is active for this thread.",
          );
        }
        // A stop cannot act twice (a retry finds no recording);
        // dropping a late one would leave capture running.
        return tab.control.agent(request.agentSessionId ?? "", () => stopRecording(tab));
      }
    }
    const tab = await requireTab(request);
    // Closing must unblock an action waiting on a dialog, without queueing behind it.
    if (request.operation === "close") {
      if (tab.control.agentId !== request.agentSessionId)
        throw new BrowserControlInterrupted(
          "Only the agent session that opened this tab can close it.",
          "agentMismatch",
        );
      if (tab.control.controller !== null)
        throw new BrowserControlInterrupted("A human controls this tab.", "humanControl");
      void tab.control.close().catch(constVoid);
      await runPromise(manager.close({ threadId: tab.threadId, tabId: tab.tabId }));
      dropTab(tab, false);
      return {};
    }
    // Resolve dialogs outside the queue, with ownership checked, to unblock waiting clicks.
    if (request.operation === "dialog") {
      if (tab.control.controller !== null)
        throw new BrowserControlInterrupted("A human controls this tab.", "humanControl");
      await resolveDialog(tab, input as PreviewAutomationDialogInput);
      return statusWithTitle(tab, request.agentSessionId);
    }
    const agentSessionId = request.agentSessionId!;

    if (
      READ_OPERATIONS.has(request.operation) &&
      tab.control.agentId !== agentSessionId &&
      !tab.control.agentCanActNow(agentSessionId)
    ) {
      return tab.control.observe(async () => {
        if (tab.dialog)
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status.",
            "dialogPending",
          );
        return executeTabOperation(tab, request);
      });
    }
    return tab.control.agent(
      agentSessionId,
      async () => {
        if (tab.dialog)
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status and use preview_dialog first.",
            "dialogPending",
          );
        const generation = tab.control.generation;
        tab.agentOperating = !READ_OPERATIONS.has(request.operation);
        updateFileChooserInterception(tab);
        try {
          return await executeTabOperation(tab, request);
        } finally {
          tab.agentOperating = false;
          updateFileChooserInterception(tab);
          if (generation !== tab.control.generation) ServerBrowserPage.invalidateRefs(tab.page);
        }
      },
      deadlineMs,
    );
  };

  const executeTabOperation = async (tab: ServerTab, request: PreviewAutomationRequest) => {
    const input = request.input;
    switch (request.operation) {
      case "navigate": {
        const navigateInput = input as PreviewAutomationNavigateInput;
        await recordAction(tab, "navigate", () =>
          navigate(
            tab,
            resolveNavigationUrl(navigateInput),
            navigateInput.readiness ?? "load",
            navigateInput.timeoutMs ?? request.timeoutMs,
          ),
        );
        return statusWithTitle(tab, request.agentSessionId);
      }
      case "resize": {
        const setting = resolvePreviewViewport(input as PreviewAutomationResizeInput);
        await runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return {
          tabId: tab.tabId,
          setting,
          viewport: tab.page.viewportSize() ?? UNATTACHED_FILL_VIEWPORT,
        };
      }
      case "setColorScheme": {
        const { colorScheme } = input as PreviewAutomationSetColorSchemeInput;
        const snapshot = await runPromise(
          manager.adjust({ threadId: tab.threadId, tabId: tab.tabId, colorScheme }),
        );
        await applyRendering(tab, snapshot);
        return { tabId: tab.tabId, colorScheme };
      }
      case "snapshot": {
        return withScreencastsPaused(tab, () =>
          ServerBrowserPage.snapshot({
            ...tab,
            renderScale: tab.desktop ? "display" : RENDER_SCALE,
          }),
        );
      }
      case "click": {
        const clickInput = input as PreviewAutomationClickInput;
        await recordAction(tab, "click", () =>
          ServerBrowserPage.click(tab.page, clickInput, pointerFor(tab)),
        );
        return undefined;
      }
      case "hover":
        return recordAction(tab, "hover", () =>
          ServerBrowserPage.hover(tab.page, input as PreviewAutomationHoverInput, pointerFor(tab)),
        );
      case "select":
        return recordAction(tab, "select", () =>
          ServerBrowserPage.select(tab.page, input as PreviewAutomationSelectInput),
        );
      case "drag":
        return recordAction(tab, "drag", () =>
          ServerBrowserPage.drag(tab.page, input as PreviewAutomationDragInput, pointerFor(tab)),
        );
      case "upload":
        return recordAction(tab, "upload", () =>
          uploadFiles(tab, input as PreviewAutomationUploadInput),
        );
      case "type":
        return recordAction(tab, "type", () =>
          ServerBrowserPage.type(tab.page, input as PreviewAutomationTypeInput),
        );
      case "press":
        return recordAction(tab, "press", () =>
          ServerBrowserPage.press(tab.page, input as PreviewAutomationPressInput),
        );
      case "scroll":
        return recordAction(tab, "scroll", () =>
          ServerBrowserPage.scroll(tab.page, input as PreviewAutomationScrollInput),
        );
      case "evaluate":
        return ServerBrowserPage.evaluate(
          tab.cdp,
          input as PreviewAutomationEvaluateInput,
          request.timeoutMs,
        );
      case "waitFor":
        return ServerBrowserPage.waitFor(tab.page, input as PreviewAutomationWaitForInput);
      case "recordingStart": {
        const recording = await startRecording(tab);
        return { tabId: tab.tabId, recording: true, startedAt: recording.startedAt };
      }
    }
  };

  return { pointerFor, recordAction, requireTab, markUsed, runOperation, executeTabOperation };
};
