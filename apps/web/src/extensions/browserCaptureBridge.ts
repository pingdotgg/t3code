/**
 * Host bridge for `t3.browser/capture@1.2.0`. `installedController` invokes the
 * returned factory once per installed client, so each
 * `ClientHost.browserCapture` checks that installation's grants and lifetime.
 *
 * Capture runs where the engine renders: the desktop preview bridge
 * rasterizes the page, or runs the in-page picker and keeps its crop. The PNG
 * goes straight to the environment's attachment store; the plugin only ever
 * receives the pending attachment id as its artifactRef.
 *
 * A page capture is also saved in the desktop's preview artifact directory,
 * like the built-in browser's screenshots. The 1.1.0 artifact actions (copy
 * image, copy path, reveal) act on that file through the same desktop bridge
 * calls the built-in "Screenshot saved" toast uses. Each installation only
 * reaches the files its own captures saved on this client.
 */
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type DesktopPreviewBridge,
  type DesktopPreviewRecordingArtifact,
  type EnvironmentId,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  BROWSER_CAPTURE,
  BROWSER_CAPTURE_ARTIFACT_ACTIONS,
  BROWSER_CAPTURE_REQUIRED_GRANTS,
  BROWSER_CAPTURE_VERSION,
  BROWSER_RECORDING_REQUIRED_GRANTS,
  type BrowserCaptureFailure,
  type BrowserRecordingRequest,
  type BrowserRecordingFailure,
  type BrowserRecordingStartResult,
  type BrowserRecordingStopResult,
  type BrowserRecordingState,
  type BrowserCaptureActionSupport,
  type BrowserCaptureArtifact,
  type BrowserCaptureArtifactActionFailureReason,
  type BrowserCaptureArtifactActionRequest,
  type BrowserCaptureArtifactActionResult,
  type BrowserCaptureFailureReason,
  type BrowserCaptureHost,
  type BrowserCapturePickedElement,
  type BrowserCaptureResult,
} from "@t3tools/extension-sdk/catalogue";
import { validateContext } from "@t3tools/extension-sdk/contracts";
import * as Schema from "effect/Schema";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import {
  uploadBrowserCapture,
  releaseBrowserCaptureArtifact,
} from "~/browser/browserCaptureArtifacts";
import {
  BrowserRecordingConflictError,
  acquireBrowserRecordingControl,
  findActiveBrowserRecordingRuntimeTabId,
  isBrowserRecordingStartCancelledError,
  readBrowserRecordingPhase,
  startBrowserRecording,
  stopBrowserRecording,
  subscribeBrowserRecording,
} from "~/browser/browserRecording";
import { showBrowserRecordingSavedToast } from "~/browser/browserRecordingToast";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { revealInFileExplorerLabel } from "~/components/preview/fileExplorerLabel";
import { previewBridge } from "~/components/preview/previewBridge";
import { dataUrlToFile } from "~/lib/imageCompression";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import { retainBrowserCaptureAnnotation } from "./browserCaptureAnnotations";
import { readThreadPreviewState } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentShell } from "~/state/shell";
import { environmentThreadShells } from "~/state/threads";

export interface BrowserCaptureBinding {
  readonly installationId?: string;
  /** The installation's grant set — the authority every capture checks. */
  readonly grants: {
    readonly capabilities: readonly string[];
    readonly projectIds: readonly string[];
  };
  /** Aborting cancels any open picker the installation started. */
  readonly lifetime: AbortSignal;
}

/** Seams the tests substitute; production defaults hit the real stores. */
export interface BrowserCaptureBridgeDeps {
  readonly preview: () => Pick<
    DesktopPreviewBridge,
    | "capturePageImage"
    | "pickElement"
    | "cancelPickElement"
    | "revealArtifact"
    | "copyArtifactToClipboard"
  > | null;
  readonly writeClipboardText: (text: string) => Promise<void>;
  readonly platform: () => string;
  readonly userActivation: () => boolean;
  readonly showSavedRecording: (artifact: DesktopPreviewRecordingArtifact) => void;
  readonly subscribeThread: (threadRef: ScopedThreadRef, listener: () => void) => () => void;
  /** Thread → project, trusted only from a live shell (see the surface bridge). */
  readonly resolveThreadScope: (threadRef: ScopedThreadRef) => {
    readonly projectId: string | null;
    readonly authoritative: boolean;
  };
  readonly serverEpoch: (threadRef: ScopedThreadRef) => string | null;
  /**
   * Whether some slot on this client shows the runtime tab, so the engine has
   * its pixels. A claimed slot that is clipped away or occluded does not count.
   */
  readonly presented: (runtimeTabId: string) => boolean;
  readonly upload: (environmentId: EnvironmentId, png: Blob, name: string) => Promise<string>;
  readonly recording: {
    readonly start: typeof startBrowserRecording;
    readonly stop: typeof stopBrowserRecording;
    readonly find: typeof findActiveBrowserRecordingRuntimeTabId;
    readonly phase: typeof readBrowserRecordingPhase;
    readonly subscribe: typeof subscribeBrowserRecording;
  };
}

const PICKED_ELEMENTS_MAX = 16;
const isRecordingConflict = Schema.is(BrowserRecordingConflictError);
/** Saved page captures each installation can still act on; the oldest drops first. */
const SAVED_CAPTURES_MAX = 32;
const clamp = (value: string, max: number) => (value.length <= max ? value : value.slice(0, max));
const clampOrNull = (value: string | null | undefined, max: number) =>
  value ? clamp(value, max) : null;

const fail = (
  reason: BrowserCaptureFailureReason,
  detail: string,
  grant?: string,
): BrowserCaptureResult => ({
  ok: false,
  failure: { reason, detail, ...(grant === undefined ? {} : { grant }) },
});

function pickedElements(annotation: PreviewAnnotationPayload): BrowserCapturePickedElement[] {
  return annotation.elements.slice(0, PICKED_ELEMENTS_MAX).map(({ element }) => ({
    tagName: clamp(element.tagName, 64),
    selector: clampOrNull(element.selector, 1024),
    componentName: clampOrNull(element.componentName, 128),
    source: element.source?.fileName
      ? {
          fileName: clamp(element.source.fileName, 512),
          lineNumber: element.source.lineNumber,
          columnNumber: element.source.columnNumber,
        }
      : null,
  }));
}

const actionFail = (
  reason: BrowserCaptureArtifactActionFailureReason,
  detail: string,
  grant?: string,
): BrowserCaptureArtifactActionResult => ({
  ok: false,
  failure: { reason, detail, ...(grant === undefined ? {} : { grant }) },
});

const captureName = (target: string, millis: number) =>
  `browser-${target}-${millis.toString(36)}.png`;

export function createBrowserCaptureBridge(
  environmentId: string,
  overrides: Partial<BrowserCaptureBridgeDeps> = {},
): (binding: BrowserCaptureBinding) => BrowserCaptureHost {
  const deps: BrowserCaptureBridgeDeps = {
    preview: () => previewBridge,
    resolveThreadScope: (threadRef) => {
      const shell = appAtomRegistry.get(environmentShell.stateValueAtom(threadRef.environmentId));
      if (shell.status !== "live") return { projectId: null, authoritative: false };
      return {
        projectId:
          appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef))?.projectId ??
          null,
        authoritative: true,
      };
    },
    serverEpoch: (threadRef) => readThreadPreviewState(threadRef).serverEpoch,
    presented: (runtimeTabId) =>
      useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible === true,
    upload: uploadBrowserCapture,
    recording: {
      start: startBrowserRecording,
      stop: stopBrowserRecording,
      find: findActiveBrowserRecordingRuntimeTabId,
      phase: readBrowserRecordingPhase,
      subscribe: subscribeBrowserRecording,
    },
    userActivation: () => navigator.userActivation?.isActive === true,
    showSavedRecording: showBrowserRecordingSavedToast,
    subscribeThread: (threadRef, listener) =>
      appAtomRegistry.subscribe(environmentShell.stateValueAtom(threadRef.environmentId), listener),
    writeClipboardText: async (text) => {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable.");
      await navigator.clipboard.writeText(text);
    },
    platform: () => navigator.platform,
    ...overrides,
  };
  // One capture per runtime tab across every installation: the picker is modal
  // inside the page, and two rasterizations of one guest would race its compositor.
  const inFlight = new Set<string>();

  return (binding) => {
    const support = deps.preview()
      ? ({ supported: true } as const)
      : ({ supported: false, reason: "desktop-required" } as const);
    /**
     * artifactRef → the saved file and the project it was captured in, for
     * this installation's page captures and recordings only.
     */
    const saved = new Map<
      string,
      { readonly path: string; readonly projectId: string; readonly image: boolean }
    >();
    const remember = (artifactRef: string, path: string, projectId: string, image: boolean) => {
      saved.set(artifactRef, { path, projectId, image });
      for (const oldest of saved.keys()) {
        if (saved.size <= SAVED_CAPTURES_MAX) break;
        saved.delete(oldest);
      }
    };
    const recordingOwned = new Map<string, () => void>();
    const stops = new Map<string, Promise<DesktopPreviewRecordingArtifact | null>>();
    const stop = (runtimeTabId: string) => {
      const existing = stops.get(runtimeTabId);
      if (existing) return existing;
      const pending = deps.recording
        .stop(runtimeTabId)
        .then((artifact) => {
          if (artifact && binding.lifetime.aborted) deps.showSavedRecording(artifact);
          return artifact;
        })
        .finally(() => stops.delete(runtimeTabId));
      stops.set(runtimeTabId, pending);
      return pending;
    };
    binding.lifetime.addEventListener(
      "abort",
      () => {
        for (const [runtimeTabId, unsubscribe] of recordingOwned) {
          unsubscribe();
          void stop(runtimeTabId).catch(() => {});
        }
        recordingOwned.clear();
        saved.clear();
      },
      { once: true },
    );

    const authorizeSession = (
      request: BrowserRecordingRequest,
      requiredGrants: readonly string[],
      starting: boolean,
    ):
      | {
          readonly ok: true;
          readonly runtimeTabId: string;
          readonly threadRef: ScopedThreadRef;
          readonly projectId: string;
          readonly preview: NonNullable<ReturnType<BrowserCaptureBridgeDeps["preview"]>>;
        }
      | { readonly ok: false; readonly failure: BrowserCaptureFailure } => {
      if (binding.lifetime.aborted)
        return {
          ok: false,
          failure: {
            reason: "host-unavailable",
            detail: "The installation's client lifetime has ended.",
          },
        };
      for (const grant of requiredGrants) {
        if (!binding.grants.capabilities.includes(grant))
          return {
            ok: false,
            failure: {
              reason: "grant-denied",
              detail: `This operation requires the ${grant} installation grant.`,
              grant,
            },
          };
      }
      let resource;
      try {
        resource = validateContext(request.context).resource;
      } catch {
        return { ok: false, failure: { reason: "scope-invalid", detail: "Invalid view context." } };
      }
      if (
        resource.environmentId !== environmentId ||
        !resource.threadId ||
        !resource.projectId ||
        !binding.grants.projectIds.includes(resource.projectId)
      )
        return {
          ok: false,
          failure: {
            reason: "scope-invalid",
            detail: "Capture requires a thread in a granted project in this environment.",
          },
        };
      const threadRef = {
        environmentId: resource.environmentId,
        threadId: resource.threadId,
      } as ScopedThreadRef;
      const scope = deps.resolveThreadScope(threadRef);
      if (!scope.authoritative)
        return {
          ok: false,
          failure: {
            reason: "host-unavailable",
            detail: "The thread's project cannot be verified until synchronization completes.",
          },
        };
      if (scope.projectId !== resource.projectId)
        return {
          ok: false,
          failure: {
            reason: "scope-invalid",
            detail: "The supplied project does not own this thread.",
          },
        };
      const { tabId, serverEpoch } = request.session ?? {};
      if (
        typeof tabId !== "string" ||
        !tabId ||
        tabId.length > 128 ||
        typeof serverEpoch !== "string" ||
        !serverEpoch ||
        serverEpoch.length > 128
      )
        return {
          ok: false,
          failure: {
            reason: "session-invalid",
            detail: "Session identity must come from t3.browser/sessions.",
          },
        };
      const preview = deps.preview();
      if (!preview)
        return {
          ok: false,
          failure: {
            reason: "desktop-required",
            detail: "Capture requires the T3 Code desktop app.",
          },
        };
      const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, tabId);
      if (starting) {
        const syncedEpoch = deps.serverEpoch(threadRef);
        if (syncedEpoch !== null && syncedEpoch !== serverEpoch)
          return {
            ok: false,
            failure: {
              reason: "epoch-changed",
              detail: "Re-list sessions after the server epoch changes.",
            },
          };
        if (!deps.presented(runtimeTabId))
          return {
            ok: false,
            failure: { reason: "not-presented", detail: "Present this session before capturing." },
          };
      }
      if (request.signal?.aborted)
        return {
          ok: false,
          failure: { reason: "cancelled", detail: "The operation was cancelled." },
        };
      return { ok: true, threadRef, runtimeTabId, projectId: resource.projectId, preview };
    };

    const recordingFail = (
      reason: BrowserRecordingFailure["reason"],
      detail: string,
    ): { readonly ok: false; readonly failure: BrowserRecordingFailure } => ({
      ok: false,
      failure: { reason, detail },
    });
    const actionSupport = support;
    const missingRecordingGrant = BROWSER_RECORDING_REQUIRED_GRANTS.find(
      (grant) => !binding.grants.capabilities.includes(grant),
    );
    const recordingSupport: BrowserCaptureActionSupport = !support.supported
      ? support
      : missingRecordingGrant
        ? { supported: false, reason: "grant-denied", grant: missingRecordingGrant }
        : support;
    const recordingActionSupport: BrowserCaptureActionSupport = !recordingSupport.supported
      ? recordingSupport
      : binding.grants.capabilities.includes(BROWSER_CAPTURE_ARTIFACT_ACTIONS)
        ? support
        : { supported: false, reason: "grant-denied", grant: BROWSER_CAPTURE_ARTIFACT_ACTIONS };

    /** Authorizes one artifact action and resolves the file it acts on. */
    const savedCapture = (
      request: BrowserCaptureArtifactActionRequest,
    ):
      | { readonly path: string; readonly image: boolean }
      | { readonly failure: BrowserCaptureArtifactActionResult } => {
      if (binding.lifetime.aborted)
        return {
          failure: actionFail(
            "host-unavailable",
            "the installation's client lifetime has already ended.",
          ),
        };
      for (const grant of BROWSER_CAPTURE_REQUIRED_GRANTS)
        if (!binding.grants.capabilities.includes(grant))
          return {
            failure: actionFail(
              "grant-denied",
              `${BROWSER_CAPTURE} requires the ${grant} installation grant.`,
              grant,
            ),
          };
      let resource;
      try {
        resource = validateContext(request.context).resource;
      } catch (error) {
        return {
          failure: actionFail(
            "scope-invalid",
            error instanceof Error ? error.message : "Invalid view context.",
          ),
        };
      }
      if (
        resource.environmentId !== environmentId ||
        !resource.projectId ||
        !binding.grants.projectIds.includes(resource.projectId)
      )
        return {
          failure: actionFail(
            "scope-invalid",
            `${BROWSER_CAPTURE} artifact actions require a context in this environment and a granted project.`,
          ),
        };
      if (!deps.preview())
        return {
          failure: actionFail(
            "desktop-required",
            "Saved captures live in the T3 Code desktop app; this client has none.",
          ),
        };
      const entry = typeof request.artifactRef === "string" && saved.get(request.artifactRef);
      // Another project's capture reads as unknown, even with both granted.
      if (!entry || entry.projectId !== resource.projectId)
        return {
          failure: actionFail(
            "artifact-not-found",
            "No page capture this installation saved in this project on this client has that artifactRef.",
          ),
        };
      if (!entry.image) {
        for (const grant of [
          ...BROWSER_RECORDING_REQUIRED_GRANTS,
          BROWSER_CAPTURE_ARTIFACT_ACTIONS,
        ]) {
          if (!binding.grants.capabilities.includes(grant))
            return {
              failure: actionFail(
                "grant-denied",
                "Saved recording actions require an installation grant.",
                grant,
              ),
            };
        }
      }
      return { path: entry.path, image: entry.image };
    };

    /**
     * Desktop errors name the absolute artifact path, so the plugin gets only
     * `failedDetail`; the raw error stays in this client's console.
     */
    const runAction = async (
      request: BrowserCaptureArtifactActionRequest,
      failedDetail: string,
      action: (path: string) => Promise<void>,
      imageOnly = false,
    ): Promise<BrowserCaptureArtifactActionResult> => {
      const resolved = savedCapture(request);
      if ("failure" in resolved) return resolved.failure;
      if (imageOnly && !resolved.image)
        return actionFail("action-failed", "Recordings cannot be copied as images.");
      try {
        await action(resolved.path);
        return { ok: true };
      } catch (error) {
        console.warn("Browser capture artifact action failed.", error);
        return actionFail("action-failed", failedDetail);
      }
    };

    return {
      id: BROWSER_CAPTURE,
      version: BROWSER_CAPTURE_VERSION,
      support,
      artifactActions: {
        copyImage: actionSupport,
        copyPath: actionSupport,
        reveal: actionSupport,
        revealLabel: revealInFileExplorerLabel(deps.platform()),
      },
      copyArtifactToClipboard: (request) =>
        runAction(
          request,
          "The saved screenshot could not be copied to the clipboard.",
          (path) => deps.preview()!.copyArtifactToClipboard(path),
          true,
        ),
      copyArtifactPath: (request) =>
        runAction(
          request,
          "The saved screenshot's path could not be copied to the clipboard.",
          deps.writeClipboardText,
        ),
      revealArtifact: (request) =>
        runAction(request, "The saved screenshot could not be shown in the file manager.", (path) =>
          deps.preview()!.revealArtifact(path),
        ),
      recordingSupport,
      recordingArtifactActions: {
        copyPath: recordingActionSupport,
        reveal: recordingActionSupport,
        revealLabel: revealInFileExplorerLabel(deps.platform()),
      },
      async startRecording(request): Promise<BrowserRecordingStartResult> {
        const authorized = authorizeSession(request, BROWSER_RECORDING_REQUIRED_GRANTS, true);
        if (!authorized.ok) return authorized;
        if (!deps.userActivation())
          return recordingFail(
            "user-activation-required",
            "Click a recording control to start recording the browser panel.",
          );
        const { runtimeTabId, threadRef } = authorized;
        if (
          recordingOwned.has(runtimeTabId) ||
          deps.recording.find(threadRef, request.session.tabId) !== null
        )
          return recordingFail("busy", "This session is already being recorded.");
        const releaseOwnership = () => {
          if (recordingOwned.get(runtimeTabId) !== unsubscribe) return;
          unsubscribe();
          recordingOwned.delete(runtimeTabId);
        };
        const releaseControl = acquireBrowserRecordingControl(runtimeTabId);
        const unsubscribeRecording = deps.recording.subscribe(() => {
          if (deps.recording.phase(runtimeTabId) === "idle") releaseOwnership();
        });
        const unsubscribe = () => {
          unsubscribeRecording();
          releaseControl();
        };
        recordingOwned.set(runtimeTabId, unsubscribe);
        const cancel = () => {
          void deps.recording.stop(runtimeTabId).catch(() => {});
        };
        request.signal?.addEventListener("abort", cancel, { once: true });
        try {
          const startedAt = await deps.recording.start(
            runtimeTabId,
            threadRef,
            request.session.tabId,
          );
          if (binding.lifetime.aborted || request.signal?.aborted) {
            await deps.recording.stop(runtimeTabId).catch(() => {});
            releaseOwnership();
            return recordingFail("cancelled", "Recording startup was cancelled.");
          }
          return { ok: true, startedAt };
        } catch (error) {
          releaseOwnership();
          return isBrowserRecordingStartCancelledError(error)
            ? recordingFail("cancelled", "Recording startup was cancelled.")
            : isRecordingConflict(error)
              ? recordingFail("busy", "This session is already being recorded.")
              : recordingFail("recording-failed", "The desktop could not start recording.");
        } finally {
          request.signal?.removeEventListener("abort", cancel);
        }
      },
      async stopRecording(request): Promise<BrowserRecordingStopResult> {
        const authorized = authorizeSession(request, BROWSER_RECORDING_REQUIRED_GRANTS, false);
        if (!authorized.ok) return authorized;
        const runtimeTabId = deps.recording.find(authorized.threadRef, request.session.tabId);
        if (runtimeTabId === null) return { ok: true, artifact: null };
        try {
          const artifact = await stop(runtimeTabId);
          if (!artifact) return { ok: true, artifact: null };
          const artifactRef = `recording-${artifact.id}`;
          if (!binding.lifetime.aborted)
            remember(artifactRef, artifact.path, authorized.projectId, false);
          return {
            ok: true,
            artifact: {
              artifactRef,
              mimeType: artifact.mimeType,
              sizeBytes: artifact.sizeBytes,
              createdAt: artifact.createdAt,
              saved: true,
            },
          };
        } catch {
          return recordingFail("recording-failed", "The desktop could not save the recording.");
        }
      },
      subscribeRecording(request, listener) {
        const authorized = authorizeSession(request, BROWSER_RECORDING_REQUIRED_GRANTS, false);
        if (
          !authorized.ok &&
          (authorized.failure.reason !== "host-unavailable" ||
            binding.lifetime.aborted ||
            request.signal?.aborted)
        ) {
          listener(authorized);
          return () => {};
        }
        let previous: BrowserRecordingState | undefined;
        const emit = (state: BrowserRecordingState) => {
          if (
            previous &&
            (state.ok
              ? previous.ok && previous.phase === state.phase
              : !previous.ok && previous.failure.reason === state.failure.reason)
          )
            return;
          previous = state;
          listener(state);
        };
        const publish = () => {
          const current = authorizeSession(request, BROWSER_RECORDING_REQUIRED_GRANTS, false);
          if (!current.ok) {
            emit(current);
            return;
          }
          const runtimeTabId = deps.recording.find(current.threadRef, request.session.tabId);
          emit({
            ok: true,
            phase: runtimeTabId === null ? "idle" : deps.recording.phase(runtimeTabId),
          });
        };
        const unsubscribe = deps.recording.subscribe(publish);
        const resource = validateContext(request.context).resource;
        const unsubscribeThread = deps.subscribeThread(
          { environmentId: resource.environmentId, threadId: resource.threadId } as ScopedThreadRef,
          publish,
        );
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          unsubscribe();
          unsubscribeThread();
          binding.lifetime.removeEventListener("abort", dispose);
          request.signal?.removeEventListener("abort", dispose);
        };
        binding.lifetime.addEventListener("abort", dispose, { once: true });
        request.signal?.addEventListener("abort", dispose, { once: true });
        publish();
        return dispose;
      },
      async capture(request): Promise<BrowserCaptureResult> {
        const authorized = authorizeSession(request, BROWSER_CAPTURE_REQUIRED_GRANTS, true);
        if (!authorized.ok) return authorized;
        const { threadRef, runtimeTabId, projectId, preview } = authorized;
        if (request.target !== "page" && request.target !== "element")
          return fail("session-invalid", 'target must be "page" or "element".');
        if (
          request.target === "element" &&
          request.annotation &&
          !binding.grants.capabilities.includes("t3.composer/write")
        )
          return fail(
            "grant-denied",
            "Adding annotations requires composer access.",
            "t3.composer/write",
          );
        if (inFlight.has(runtimeTabId))
          return fail("busy", "Another capture of this session is still running.");

        inFlight.add(runtimeTabId);
        const cancelPick = () => void preview.cancelPickElement(runtimeTabId).catch(() => {});
        const detach = () => {
          request.signal?.removeEventListener("abort", cancelPick);
          binding.lifetime.removeEventListener("abort", cancelPick);
        };
        try {
          let png: Blob;
          let retainedAnnotation: ReturnType<typeof retainBrowserCaptureAnnotation> | null = null;
          const imageFailure = (
            reason: BrowserCaptureFailureReason,
            detail: string,
          ): BrowserCaptureResult => ({
            ...fail(reason, detail),
            ...(retainedAnnotation ? { annotationRef: retainedAnnotation.annotationRef } : {}),
          });
          let savedPath: string | null = null;
          let partial: Omit<BrowserCaptureArtifact, "artifactRef" | "sizeBytes">;
          if (request.target === "page") {
            let image;
            try {
              image = await preview.capturePageImage(runtimeTabId);
            } catch (error) {
              return fail(
                "capture-failed",
                error instanceof Error ? error.message : "The page could not be captured.",
              );
            }
            // Rasterizing cannot be interrupted, but an abort that lands
            // meanwhile still cancels before anything is stored.
            if (request.signal?.aborted || binding.lifetime.aborted)
              return fail("cancelled", "The capture was cancelled.");
            png = new Blob([new Uint8Array(image.data)], { type: "image/png" });
            savedPath = image.path;
            partial = {
              mimeType: "image/png",
              width: image.width,
              height: image.height,
              target: "page",
              pageUrl: clampOrNull(image.pageUrl, 2048),
              pageTitle: clampOrNull(image.pageTitle, 512),
            };
          } else {
            request.signal?.addEventListener("abort", cancelPick, { once: true });
            binding.lifetime.addEventListener("abort", cancelPick, { once: true });
            let picked;
            try {
              picked = await preview.pickElement(runtimeTabId);
            } catch (error) {
              // Native treats a picker that throws as a dismissal: no image
              // was ever taken, so capture-failed stays reserved for a lost crop.
              return fail(
                "cancelled",
                error instanceof Error ? error.message : "The element picker closed.",
              );
            } finally {
              detach();
            }
            if (!picked || request.signal?.aborted || binding.lifetime.aborted)
              return fail("cancelled", "The element pick was dismissed.");
            const { annotation } = picked;
            if (request.annotation && binding.installationId) {
              const capture = capturePreviewAnnotationScreenshot(annotation);
              const file =
                !picked.screenshotFailed &&
                capture.status === "captured" &&
                capture.file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                  ? capture.file
                  : null;
              const screenshotFailed =
                picked.screenshotFailed === true ||
                capture.status === "failed" ||
                (capture.status === "captured" && file === null);
              retainedAnnotation = retainBrowserCaptureAnnotation({
                environmentId,
                threadId: threadRef.threadId,
                installationId: binding.installationId,
                lifetime: request.signal
                  ? AbortSignal.any([binding.lifetime, request.signal])
                  : binding.lifetime,
                annotation: file ? annotation : { ...annotation, screenshot: null },
                file,
                screenshotFailed,
                submission: picked.submission,
                releaseArtifact: (artifactRef) =>
                  releaseBrowserCaptureArtifact(threadRef.environmentId, artifactRef),
              });
            }
            if (request.annotation && retainedAnnotation)
              return { ok: true, artifact: null, annotationRef: retainedAnnotation.annotationRef };
            const screenshot = annotation.screenshot;
            if (!screenshot || picked.screenshotFailed)
              return imageFailure("capture-failed", "The picker kept no crop of the selection.");
            try {
              // Electron hands the crop to the renderer as a data URL; it is
              // decoded here and never leaves this client in that form.
              png = dataUrlToFile(screenshot.dataUrl, "crop.png", "image/png");
            } catch {
              return imageFailure("capture-failed", "The picker's crop could not be decoded.");
            }
            partial = {
              mimeType: "image/png",
              width: Math.max(1, Math.round(screenshot.width)),
              height: Math.max(1, Math.round(screenshot.height)),
              target: "element",
              pageUrl: clampOrNull(annotation.pageUrl, 2048),
              pageTitle: clampOrNull(annotation.pageTitle, 512),
              comment: clamp(annotation.comment, 4000),
              elements: pickedElements(annotation),
            };
          }
          if (png.size === 0) return imageFailure("capture-failed", "The capture is empty.");
          if (png.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
            return imageFailure("too-large", "The capture exceeds the image attachment limit.");
          let artifactRef: string;
          try {
            artifactRef = await deps.upload(
              threadRef.environmentId,
              png,
              captureName(request.target, Date.now()),
            );
          } catch (error) {
            return imageFailure(
              "upload-failed",
              error instanceof Error ? error.message : "The capture could not be stored.",
            );
          }
          retainedAnnotation?.setArtifact(artifactRef);
          if (request.signal?.aborted || binding.lifetime.aborted) {
            if (!retainedAnnotation)
              releaseBrowserCaptureArtifact(threadRef.environmentId, artifactRef);
            retainedAnnotation?.discard();
            return fail("cancelled", "The capture was cancelled.");
          }
          if (savedPath !== null) {
            remember(artifactRef, savedPath, projectId, true);
          }
          return {
            ok: true,
            ...(retainedAnnotation ? { annotationRef: retainedAnnotation.annotationRef } : {}),
            artifact: {
              ...partial,
              artifactRef,
              sizeBytes: png.size,
              saved: savedPath !== null,
            },
          };
        } finally {
          detach();
          inFlight.delete(runtimeTabId);
        }
      },
    };
  };
}
