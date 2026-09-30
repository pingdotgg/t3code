import * as Effect from "effect/Effect";
import type {
  PreviewAutomationOperation,
  PreviewAutomationOpenInput,
  PreviewAutomationPreflightResult,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationRecordingTransferResult,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationOpenAndSnapshotResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabsResult,
  PreviewTabId,
} from "@t3tools/contracts";
import { PREVIEW_RECORDING_TRANSFER_MAX_BYTES } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import {
  recordingExtensionForMimeType,
  resolveBrowserEvidenceDir,
  saveBrowserEvidenceFile,
} from "../../PreviewEvidence.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  // Keep both fields populated while mixed-version renderer hosts exist.
  // `open` is authoritative; `show` remains a deprecated compatibility alias.
  const open = input.open ?? input.show ?? true;
  return {
    ...input,
    open,
    show: open,
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  A,
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requirePreviewCapability();
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return yield* broker.invoke<A>({
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
});

const invokeTargeted = <A>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId);
};

/**
 * Pull finished recording bytes from the browser host and store an
 * agent-readable copy next to the server. Any failure (older host without
 * `recordingTransfer`, evicted renderer cache, oversized payload, disk error)
 * falls back to the host-local artifact so stopping a recording never fails
 * because the transfer did.
 */
const transferRecordingToServer = (
  tabId: PreviewTabId | undefined,
  artifact: PreviewAutomationRecordingArtifact,
): Effect.Effect<
  PreviewAutomationRecordingArtifact,
  unknown,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> =>
  Effect.gen(function* () {
    const transfer = yield* invoke<PreviewAutomationRecordingTransferResult>(
      "recordingTransfer",
      { recordingId: artifact.id },
      undefined,
      tabId,
    );
    const bytes = Buffer.from(transfer.data, "base64");
    if (
      bytes.length === 0 ||
      bytes.length !== transfer.sizeBytes ||
      bytes.length > PREVIEW_RECORDING_TRANSFER_MAX_BYTES
    ) {
      yield* Effect.logWarning("discarding corrupt recording transfer", {
        recordingId: artifact.id,
        expectedBytes: transfer.sizeBytes,
        actualBytes: bytes.length,
      });
      return artifact;
    }
    const path = yield* Effect.tryPromise(() =>
      saveBrowserEvidenceFile({
        directory: resolveBrowserEvidenceDir(),
        prefix: `browser-recording-${artifact.id}`,
        extension: recordingExtensionForMimeType(transfer.mimeType),
        bytes,
      }),
    );
    return { ...artifact, path, transferred: true as const };
  });

const handlers = {
  preview_status: (input) => invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  preview_tabs: (input) => invokeTargeted<PreviewAutomationTabsResult>("listTabs", input ?? {}),
  preview_open: (input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  preview_open_and_snapshot: (input) => {
    const normalized = normalizePreviewOpenInput({
      ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.open === undefined ? {} : { open: input.open }),
      ...(input.show === undefined ? {} : { show: input.show }),
      ...(input.reuseExistingTab === undefined ? {} : { reuseExistingTab: input.reuseExistingTab }),
    });
    return invokeTargeted<PreviewAutomationOpenAndSnapshotResult>(
      "openAndSnapshot",
      {
        ...input,
        ...normalized,
      },
      input.timeoutMs,
    );
  },
  preview_preflight: (input) =>
    invokeTargeted<PreviewAutomationPreflightResult>("preflight", input, input.timeoutMs),
  preview_navigate: (input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  preview_resize: (input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  preview_set_appearance: (input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  preview_snapshot: (input) => invokeTargeted<PreviewAutomationSnapshot>("snapshot", input ?? {}),
  preview_click: (input) =>
    invokeTargeted<void>("click", input, input.timeoutMs).pipe(Effect.as({ ok: true as const })),
  preview_type: (input) =>
    invokeTargeted<void>("type", input, input.timeoutMs).pipe(Effect.as({ ok: true as const })),
  preview_press: (input) =>
    invokeTargeted<void>("press", input).pipe(Effect.as({ ok: true as const })),
  preview_scroll: (input) =>
    invokeTargeted<void>("scroll", input).pipe(Effect.as({ ok: true as const })),
  preview_evaluate: (input) =>
    invokeTargeted<unknown>("evaluate", input).pipe(
      Effect.map((result) => ({ value: result ?? null })),
    ),
  preview_wait_for: (input) =>
    invokeTargeted<void>("waitFor", input, input.timeoutMs).pipe(Effect.as({ ok: true as const })),
  preview_recording_start: (input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  preview_recording_stop: (input) =>
    invokeTargeted<PreviewAutomationRecordingArtifact>("recordingStop", input ?? {}).pipe(
      Effect.flatMap((artifact) =>
        transferRecordingToServer(input?.tabId, artifact).pipe(
          Effect.orElseSucceed(() => artifact),
        ),
      ),
    ),
} satisfies Parameters<typeof PreviewToolkit.toLayer>[0];

const { preview_snapshot, preview_open_and_snapshot, ...standardHandlers } = handlers;

export const PreviewStandardToolkitHandlersLive = PreviewStandardToolkit.toLayer(standardHandlers);

export const PreviewSnapshotToolkitHandlersLive = PreviewSnapshotToolkit.toLayer({
  preview_snapshot,
  preview_open_and_snapshot,
});

export const PreviewToolkitHandlersLive = PreviewToolkit.toLayer(handlers);
