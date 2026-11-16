import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";

import { parseLegacyNewTaskDraftKey } from "../state/new-task-draft-key";
import type { DraftComposerAttachment } from "./composerImages";

export interface ComposerAttachmentUploadRequest {
  readonly environmentId: EnvironmentId;
  readonly attachment: DraftComposerAttachment;
}

export type ComposerAttachmentUploadState =
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly reason: string };

export function composerAttachmentUploadKey(
  environmentId: EnvironmentId,
  attachmentId: string,
): string {
  return `${environmentId}:${attachmentId}`;
}

/** Environment and thread ids may both contain colons, so a thread draft key resolves to the longest known environment it starts with. */
export function composerDraftEnvironmentId(
  draftKey: string,
  environmentIds: Iterable<EnvironmentId>,
  queuedMessages: ReadonlyArray<{
    readonly messageId: string;
    readonly environmentId: EnvironmentId;
  }>,
  draft?: { readonly project?: { readonly environmentId: EnvironmentId } },
): EnvironmentId | null {
  if (draftKey.startsWith("pending-task:")) {
    return (
      queuedMessages.find((message) => `pending-task:${message.messageId}` === draftKey)
        ?.environmentId ?? null
    );
  }
  if (draftKey.startsWith("new-task:")) {
    if (draft?.project) {
      return draft.project.environmentId;
    }
    const legacy = parseLegacyNewTaskDraftKey(draftKey);
    return legacy === null ? null : EnvironmentId.make(legacy.environmentId);
  }
  let match: EnvironmentId | null = null;
  for (const environmentId of environmentIds) {
    if (
      draftKey.startsWith(`${environmentId}:`) &&
      (match === null || environmentId.length > match.length)
    ) {
      match = environmentId;
    }
  }
  return match;
}

type UploadServerConfig = {
  readonly environment: {
    readonly capabilities: Pick<ServerConfig["environment"]["capabilities"], "fileAttachments">;
  };
};

export function canUploadComposerAttachment(
  attachment: DraftComposerAttachment,
  config: UploadServerConfig | null | undefined,
): boolean {
  const capabilities = config?.environment.capabilities;
  return (
    capabilities !== undefined &&
    (attachment.type === "image" ||
      (capabilities.fileAttachments !== undefined &&
        attachment.sizeBytes <=
          clampFileAttachmentUploadBytes(capabilities.fileAttachments.maxUploadBytes)))
  );
}

export function composerAttachmentUploadBlockReason(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly connected: boolean;
  readonly serverConfig: UploadServerConfig | null;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): string | null {
  if (!input.connected) return null;
  for (const attachment of input.attachments) {
    if (!canUploadComposerAttachment(attachment, input.serverConfig)) continue;
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)];
    if (state?.status === "failed") return "Retry or remove the failed attachment";
  }
  return null;
}

export function composerAttachmentsStillUploading(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly serverConfig: UploadServerConfig | null;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): boolean {
  return input.attachments.some((attachment) => {
    if (!canUploadComposerAttachment(attachment, input.serverConfig)) return false;
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)];
    return state?.status !== "ready" && state?.status !== "failed";
  });
}

/** Changes when an upload starts or settles, not on its progress ticks. */
export function uploadingComposerAttachmentKeys(
  states: Readonly<Record<string, ComposerAttachmentUploadState>>,
): string {
  return Object.keys(states)
    .filter((key) => states[key]?.status === "uploading")
    .sort()
    .join("\n");
}

/** A queued message waits for the worker's upload instead of starting a second one. */
export function queuedAttachmentsStillUploading(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): boolean {
  return input.attachments.some(
    (attachment) =>
      attachment.uploadedAttachmentId === undefined &&
      input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)]?.status ===
        "uploading",
  );
}

/** Equal by environment and attachment id; the request rides along for the upload. */
class UploadKey implements Equal.Equal {
  constructor(
    readonly id: string,
    readonly request: ComposerAttachmentUploadRequest | null,
  ) {}
  static of(request: ComposerAttachmentUploadRequest): UploadKey {
    return new UploadKey(
      composerAttachmentUploadKey(request.environmentId, request.attachment.id),
      request,
    );
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof UploadKey && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

/**
 * Every upload of a composer attachment, shared by key: the composer holds the attachments it
 * shows or has queued, and a send joins the upload already running instead of starting another.
 * An upload is interrupted once nothing holds it.
 */
export function createComposerAttachmentUploadQueue(options: {
  readonly upload: (
    request: ComposerAttachmentUploadRequest,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ) => Promise<string>;
  /** Saves a finished upload's id; the upload is ready once this succeeds. */
  readonly onUploaded?: (
    request: ComposerAttachmentUploadRequest,
    uploadedId: string,
  ) => Effect.Effect<void, ComposerAttachmentUploadError>;
  readonly onChange: (states: Readonly<Record<string, ComposerAttachmentUploadState>>) => void;
}) {
  let states: Readonly<Record<string, ComposerAttachmentUploadState>> = {};
  function setState(key: string, state: ComposerAttachmentUploadState | undefined) {
    const previous = states[key];
    if (
      previous === state ||
      (previous?.status === "uploading" &&
        state?.status === "uploading" &&
        previous.progress === state.progress)
    )
      return;
    const next = { ...states };
    if (state) next[key] = state;
    else delete next[key];
    states = next;
    options.onChange(states);
  }

  const permits = Semaphore.makeUnsafe(3);
  const running = new Set<Fiber.Fiber<string, ComposerAttachmentUploadError>>();
  // The latest transfer per attachment: a re-added attachment waits for an aborted one to settle.
  const transfers = new Map<string, Fiber.Fiber<string, ComposerAttachmentUploadError>>();

  /** The native transfer; interrupting it aborts the request and waits for it to settle. */
  const nativeTransfer = (key: UploadKey) =>
    Effect.suspend(() => {
      const controller = new AbortController();
      if (states[key.id]?.status !== "uploading") {
        setState(key.id, { status: "uploading", progress: 0 });
      }
      const done = options.upload(key.request!, controller.signal, (progress) => {
        if (controller.signal.aborted) return;
        setState(key.id, {
          status: "uploading",
          progress: Math.floor(Math.max(0, Math.min(1, progress)) * 20) / 20,
        });
      });
      return Effect.tryPromise({ try: () => done, catch: uploadError }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => controller.abort()).pipe(
            Effect.andThen(Effect.tryPromise({ try: () => done, catch: uploadError })),
            Effect.ignore,
          ),
        ),
      );
    });

  const transfer = (key: UploadKey, previous: Fiber.Fiber<string, unknown> | undefined) =>
    (previous === undefined ? Effect.void : Fiber.await(previous)).pipe(
      Effect.andThen(nativeTransfer(key).pipe(Semaphore.withPermits(permits, 1))),
      Effect.tap((uploadedId) => options.onUploaded?.(key.request!, uploadedId) ?? Effect.void),
      Effect.tap(() => Effect.sync(() => setState(key.id, { status: "ready" }))),
      Effect.tapError((error) =>
        Effect.sync(() => setState(key.id, { status: "failed", reason: error.message })),
      ),
    );

  const scope = Scope.makeUnsafe();
  const uploads = Effect.runSync(
    Scope.provide(scope)(
      RcMap.make({
        lookup: Effect.fn("ComposerAttachmentUploads.lookup")(function* (key: UploadKey) {
          setState(key.id, { status: "uploading", progress: 0 });
          yield* Effect.addFinalizer(() => Effect.sync(() => setState(key.id, undefined)));
          const fiber = yield* Effect.forkScoped(transfer(key, transfers.get(key.id)));
          transfers.set(key.id, fiber);
          running.add(fiber);
          fiber.addObserver(() => {
            running.delete(fiber);
            if (transfers.get(key.id) === fiber) transfers.delete(key.id);
          });
          return fiber;
        }),
      }),
    ),
  );

  const holders = new Map<string, Scope.Closeable>();
  let requested: ReadonlyArray<ComposerAttachmentUploadRequest> = [];
  let disposed = false;
  const release = (id: string) => {
    const holder = holders.get(id);
    if (!holder) return;
    holders.delete(id);
    Effect.runFork(Scope.close(holder, Exit.void));
  };

  /** Holds exactly these uploads; anything no longer requested and held nowhere else stops. */
  function sync(requests: ReadonlyArray<ComposerAttachmentUploadRequest>) {
    if (disposed) return;
    requested = requests;
    const keys = new Map(requests.map((request) => [UploadKey.of(request).id, request]));
    for (const id of holders.keys()) {
      if (!keys.has(id)) release(id);
    }
    for (const [id, request] of keys) {
      if (holders.has(id)) continue;
      const holder = Scope.makeUnsafe();
      holders.set(id, holder);
      Effect.runSync(Scope.provide(holder)(RcMap.get(uploads, UploadKey.of(request))));
    }
  }

  return {
    sync,
    /** Uploads the attachment, joining its running upload when there is one. */
    upload(
      request: ComposerAttachmentUploadRequest,
    ): Effect.Effect<string, ComposerAttachmentUploadError> {
      return disposed
        ? Effect.fail(uploadError(new Error("Upload cancelled.")))
        : RcMap.get(uploads, UploadKey.of(request)).pipe(Effect.flatMap(Fiber.join), Effect.scoped);
    },
    retry(environmentId: EnvironmentId, attachmentId: string) {
      const id = composerAttachmentUploadKey(environmentId, attachmentId);
      if (states[id]?.status !== "failed") return;
      Effect.runSync(RcMap.invalidate(uploads, new UploadKey(id, null)));
      release(id);
      sync(requested);
    },
    async settled() {
      while (running.size > 0) {
        await Effect.runPromise(Fiber.awaitAll([...running]));
      }
    },
    dispose() {
      disposed = true;
      holders.clear();
      Effect.runFork(Scope.close(scope, Exit.void));
      states = {};
      options.onChange(states);
    },
  };
}

export function uploadError(cause: unknown): ComposerAttachmentUploadError {
  if (isComposerAttachmentUploadError(cause)) return cause;
  return new ComposerAttachmentUploadError({
    message: cause instanceof Error ? cause.message : "Upload failed. Tap to retry.",
    cause,
  });
}

export class ComposerAttachmentUploadError extends Schema.TaggedError<ComposerAttachmentUploadError>()(
  "ComposerAttachmentUploadError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

const isComposerAttachmentUploadError = Schema.is(ComposerAttachmentUploadError);
