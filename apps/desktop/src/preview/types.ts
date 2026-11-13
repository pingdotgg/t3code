import {
  DesktopPreviewRecordingInputSchema,
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
} from "@t3tools/contracts";
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewFavicon,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewPointerEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  PreviewAnnotationSubmissionResult,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabDefaults,
  PreviewForwardedShortcut,
} from "@t3tools/contracts";
import {
  BrowserWindow,
  ClipboardItem,
  app,
  type Session,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { DEFAULT_RECORDING_INPUT_OPTIONS, type RecordingInputOptions } from "./RecordingInput.ts";
import {
  PreviewManagerError,
} from "./errors.ts";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  audioMuted: boolean;
  audible: boolean;
  controller: "human" | "agent" | "none";
  capturing: boolean;
  favicon?: DesktopPreviewFavicon;
  serverTab?: { readonly threadId: string; readonly tabId: string };
  updatedAt: string;
}

export const PreviewAutomationSelectorKind = Schema.Literals([
  "focused-element",
  "selector",
  "locator",
]);
export type PreviewAutomationSelectorKind = typeof PreviewAutomationSelectorKind.Type;

export const PreviewAutomationEvaluationDetailKind = Schema.Literals([
  "exception-description",
  "exception-text",
  "unknown",
]);
export type PreviewAutomationEvaluationDetailKind =
  typeof PreviewAutomationEvaluationDetailKind.Type;

export interface PreviewOperationContext {
  readonly operation: string;
  readonly tabId?: string;
  readonly webContentsId?: number;
  readonly artifactPath?: string;
}

export type Listener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;

export type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

export interface ManagedListeners {
  readonly attachmentId: symbol;
  readonly cancelFaviconCapture: () => void;
  readonly scope: Scope.Closeable;
  readonly webContents: Electron.WebContents;
}

export type FrameCaptureConsumer = "picture-in-picture" | "recording";

export interface FrameCaptureSession {
  readonly recordingInputOptions?: RecordingInputOptions;
  readonly scope: Scope.Closeable | null;
  readonly consumers: ReadonlySet<FrameCaptureConsumer>;
  readonly unthrottledWebContentsIds: ReadonlySet<number>;
  readonly lastPictureInPictureFingerprint: string | null;
}

export interface PictureInPictureSession {
  readonly window: BrowserWindow;
  readonly webContentsId: number;
  readonly ready: Deferred.Deferred<void, PreviewManagerError>;
  readonly initializationScope: Scope.Closeable;
}

export interface PendingRecording {
  readonly tabId: string;
  readonly webContents: Electron.WebContents;
  readonly requestingFrameTreeNodeId: number;
  readonly armedAtMillis: number;
}

export interface PickSession {
  readonly cancel: Effect.Effect<void>;
}

export interface BrowserControlSession {
  readonly webContentsId: number;
  // Retain the attached Debugger to prevent GC crashes (electron/electron#53376); wc.debugger throws after destruction.
  readonly debugger: Electron.Debugger;
  readonly semaphore: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void;
}

export const isRecordingInput = Schema.is(DesktopPreviewRecordingInputSchema);

export type RecordingInputListener = (event: DesktopPreviewRecordingInputEvent) => Effect.Effect<void>;

export type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;

export type OpenLinkListener = (event: DesktopPreviewOpenLinkEvent) => Effect.Effect<void>;

// about:blank inherits relaxed guest preferences; external editor schemes must reach the OS handler.
