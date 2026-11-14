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

export interface ServerBrowserRecordingDeps {
  readonly contexts: ServerBrowserContexts;
  readonly attachmentsDir: string;
  readonly frameRate: () => 30 | 60;
}

export const createServerBrowserRecording = (deps: ServerBrowserRecordingDeps) => {
  const { contexts, attachmentsDir, frameRate } = deps;

  const withCaptureLock = <A>(tab: ServerTab, operation: () => Promise<A>): Promise<A> => {
    const run = tab.captureLock.then(() => {
      if (tab.closing) throw new Error("The preview tab closed.");
      return operation();
    });
    tab.captureLock = run.then(constVoid, constVoid);
    return run;
  };

  const startRecording = (tab: ServerTab): Promise<Recording> => {
    const started = withCaptureLock(tab, async () => {
      if (tab.recording) return tab.recording;
      const encoder = await contexts.scratchPage();
      let session: CDPSession | null = null;
      try {
        await encoder.evaluate(ServerBrowserPage.recordingEncoderScript(frameRate()));
        // Seed idle pages before returning so an immediate stop has a frame to encode.
        const firstFrame = await ServerBrowserPage.captureViewport(tab.cdp, {
          format: "jpeg",
          quality: RECORDING_SCREENCAST.quality,
        });
        await encoder.evaluate(
          ([data, width]) =>
            (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
          [firstFrame, tab.page.viewportSize()?.width ?? UNATTACHED_FILL_VIEWPORT.width] as const,
        );
        const opened = await tab.page.context().newCDPSession(tab.page);
        session = opened;
        const framesInFlight = new Set<Promise<void>>();
        opened.on("Page.screencastFrame", (frame) => {
          const cssWidth = tab.page.viewportSize()?.width ?? frame.metadata.deviceWidth;
          const delivered: Promise<void> = encoder
            .evaluate(
              ([data, width]) =>
                (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
              [frame.data, cssWidth] as const,
            )
            .then(async (accepted) => {
              if (!accepted) await opened.send("Page.stopScreencast");
            })
            .catch(constVoid)
            .finally(() => {
              framesInFlight.delete(delivered);
              void opened
                .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                .catch(constVoid);
            });
          framesInFlight.add(delivered);
        });
        await opened.send("Page.startScreencast", RECORDING_SCREENCAST);
        if (tab.closing) throw new Error("The tab closed while the recording started.");
        const recording: Recording = {
          encoder,
          session: opened,
          startedAt: new Date().toISOString(),
          framesInFlight,
        };
        tab.recording = recording;
        return recording;
      } catch (cause) {
        await encoder.close().catch(constVoid);
        await session?.detach().catch(constVoid);
        throw cause;
      }
    }).finally(() => {
      if (tab.recordingStart === started) tab.recordingStart = null;
    });
    tab.recordingStart = started;
    return started;
  };

  const withScreencastsPaused = <A>(tab: ServerTab, capture: () => Promise<A>): Promise<A> =>
    withCaptureLock(tab, async () => {
      tab.capturing += 1;
      const recording = tab.recording;
      try {
        await Promise.all([
          ...[...tab.viewers].map((viewer) => viewer.pause()),
          recording?.session.send("Page.stopScreencast").catch(constVoid),
        ]);
        return await capture();
      } finally {
        tab.capturing -= 1;

        await Promise.all([
          ...[...tab.viewers].map((viewer) => viewer.resume()),
          recording && tab.recording === recording
            ? recording.session.send("Page.startScreencast", RECORDING_SCREENCAST).catch(constVoid)
            : undefined,
        ]);
      }
    });

  const stopRecording = (tab: ServerTab) =>
    withCaptureLock(tab, async () => {
      const recording = tab.recording;
      if (!recording) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationRecordingNotActiveError",
          "No recording is active for this tab.",
        );
      }
      let mimeType: string | null;
      const chunks: Array<Buffer> = [];
      try {
        await recording.session.send("Page.stopScreencast").catch(constVoid);
        await Promise.all(recording.framesInFlight);
        await recording.session.detach().catch(constVoid);
        const stopped = await recording.encoder.evaluate(() =>
          (globalThis as unknown as EncoderWindow).__t3Recorder.stop(),
        );
        mimeType = stopped.mimeType;
        // Checked before the transfer so an oversized video never lands in this process.
        if (stopped.bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingTooLargeError",
            "The recording is larger than the attachment limit.",
          );
        }
        for (let index = 0; index < stopped.count; index += 1) {
          const chunk = await recording.encoder.evaluate(
            (chunkIndex) => (globalThis as unknown as EncoderWindow).__t3Recorder.chunk(chunkIndex),
            index,
          );
          chunks.push(Buffer.from(chunk, "base64"));
        }
      } finally {
        await recording.encoder.close().catch(constVoid);
        tab.recording = null;
      }
      const data = Buffer.concat(chunks);
      if (!mimeType || data.byteLength === 0) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          "The recording captured no frames.",
        );
      }

      const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
      const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}-${extension}`;
      const path = NodePath.join(attachmentsDir, `${pendingId}.${extension}`);
      await NodeFSP.mkdir(attachmentsDir, { recursive: true });
      await NodeFSP.writeFile(path, data);
      return {
        id: pendingId,
        tabId: tab.tabId,
        path,
        mimeType: mimeType.split(";")[0]!,
        sizeBytes: data.byteLength,
        createdAt: new Date().toISOString(),
        uploadedAttachmentId: pendingId,
      };
    });

  return { withCaptureLock, startRecording, stopRecording, withScreencastsPaused };
};
