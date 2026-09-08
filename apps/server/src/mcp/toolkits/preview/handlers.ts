import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingArtifact,
  type ThreadId,
  type PreviewAutomationError,
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewBrowserEngine,
  type PreviewTabId,
} from "@t3tools/contracts";

import {
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PlaywrightPreviewHost from "../../PlaywrightPreviewHost.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

/**
 * Collapses the `show` alias onto `open` and defaults tab reuse.
 *
 * Deliberately leaves an unstated `open` unstated. Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const noDesktopStatus: PreviewAutomationStatus = {
  available: false,
  visible: false,
  tabId: null,
  url: null,
  title: null,
  loading: false,
};

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly engine?: PreviewBrowserEngine | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
): Effect.fn.Return<
  A,
  PreviewAutomationError,
  | McpInvocationContext.McpInvocationContext
  | PreviewAutomationBroker.PreviewAutomationBroker
  | PlaywrightPreviewHost.PlaywrightPreviewHost
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview");
  const { tabId, ...operationInput } = input;
  const request = {
    operation,
    input: operationInput,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  };
  const isEngineTab =
    tabId === undefined
      ? operation === "open" && input.engine !== undefined
      : PlaywrightPreviewHost.isEngineTabId(tabId);
  if (isEngineTab) {
    const host = yield* PlaywrightPreviewHost.PlaywrightPreviewHost;
    return yield* host.invoke<A>(request);
  }
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({ scope, ...request });
});

const UploadedRecordingArtifact = Schema.Struct({
  ...PreviewAutomationRecordingArtifact.fields,
  uploadedAttachmentId: Schema.optional(Schema.String),
});
const decodeUploadedRecordingArtifact = Schema.decodeUnknownEffect(UploadedRecordingArtifact);

export const claimPreviewRecording = Effect.fn("PreviewToolkit.claimRecording")(function* (
  threadId: ThreadId,
  response: unknown,
) {
  const artifact = yield* decodeUploadedRecordingArtifact(response).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewAutomationRecordingTransferError({
          threadId,
          cause,
        }),
    ),
  );
  if (!artifact.uploadedAttachmentId) {
    return yield* new PreviewAutomationRecordingDesktopUpdateRequiredError({ threadId });
  }
  const config = yield* ServerConfig.ServerConfig;
  const uuid = parseAttachmentUuid(artifact.uploadedAttachmentId);
  const extension = parseAttachmentFileExtension(artifact.uploadedAttachmentId);
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension}`;
  if (!uuid || !extension || !threadSegment || artifact.uploadedAttachmentId !== pendingId) {
    return yield* new PreviewAutomationRecordingTransferError({
      threadId,
    });
  }
  // The same completed upload can be returned to overlapping stop requests.
  const finalId = `${threadSegment}-${uuid}-${extension}`;
  const currentPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${pendingId}.${extension}`,
  });
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${finalId}.${extension}`,
  });
  if (!currentPath || !finalPath) {
    return yield* new PreviewAutomationRecordingTransferError({ threadId });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const validateFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.filterOrFail(
        (stat) =>
          stat.type === "File" &&
          Number(stat.size) === artifact.sizeBytes &&
          artifact.sizeBytes > 0 &&
          artifact.sizeBytes <= PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        () => new PreviewAutomationRecordingTransferError({ threadId }),
      ),
    );
  yield* Effect.gen(function* () {
    yield* validateFile(currentPath);
    yield* fileSystem.rename(currentPath, finalPath);
  }).pipe(
    // Another stop may already have claimed this exact upload for this thread.
    Effect.catch((cause) =>
      cause._tag !== "PreviewAutomationRecordingTransferError" && cause.reason._tag === "NotFound"
        ? validateFile(finalPath)
        : Effect.fail(cause),
    ),
    Effect.mapError((cause) => new PreviewAutomationRecordingTransferError({ threadId, cause })),
  );
  const { uploadedAttachmentId: _uploadedAttachmentId, ...recording } = artifact;
  return { ...recording, id: finalId, path: finalPath };
});

const handlers = {
  preview_status: (input) =>
    Effect.gen(function* () {
      const host = yield* PlaywrightPreviewHost.PlaywrightPreviewHost;
      const engines = yield* host.installedEngines;
      const status = yield* invoke<PreviewAutomationStatus>("status", input ?? {}).pipe(
        Effect.catchTag("PreviewAutomationNoAvailableHostError", () =>
          Effect.succeed(noDesktopStatus),
        ),
      );
      return { ...status, engines };
    }),
  preview_open: (input) =>
    invoke<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  preview_navigate: (input) => invoke<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  preview_resize: (input) =>
    invoke<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  preview_set_appearance: (input) =>
    invoke<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  preview_snapshot: (input) => {
    // Output selection and saving are MCP-only; the browser still produces a complete snapshot.
    const { includeImage: _includeImage, save: _save, ...operationInput } = input ?? {};
    return invoke<PreviewAutomationSnapshot>("snapshot", operationInput);
  },
  preview_click: (input) => invoke<void>("click", input, input.timeoutMs).pipe(Effect.as({})),
  preview_type: (input) => invoke<void>("type", input, input.timeoutMs).pipe(Effect.as({})),
  preview_press: (input) => invoke<void>("press", input).pipe(Effect.as({})),
  preview_scroll: (input) => invoke<void>("scroll", input).pipe(Effect.as({})),
  preview_evaluate: (input) =>
    invoke<unknown>("evaluate", input).pipe(Effect.map((result) => ({ value: result ?? null }))),
  preview_wait_for: (input) => invoke<void>("waitFor", input, input.timeoutMs).pipe(Effect.as({})),
  preview_recording_start: (input) =>
    invoke<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  preview_recording_stop: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("preview");
      const response = yield* invoke<unknown>(
        "recordingStop",
        { ...input, transferToEnvironment: true },
        PREVIEW_RECORDING_STOP_TIMEOUT_MS,
      );
      return yield* claimPreviewRecording(scope.threadId, response);
    }),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0];

const { preview_snapshot, ...standardHandlers } = handlers;

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers);

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
});
