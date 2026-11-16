import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export class AttachmentUploadError extends Schema.TaggedError<AttachmentUploadError>()(
  "AttachmentUploadError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

const isAttachmentUploadError = Schema.is(AttachmentUploadError);

export function attachmentUploadError(cause: unknown): AttachmentUploadError {
  if (isAttachmentUploadError(cause)) return cause;
  return new AttachmentUploadError({
    message: cause instanceof Error ? cause.message : "Upload failed. Tap to retry.",
    cause,
  });
}

/**
 * Runs a promise-based transfer as an Effect. Interrupting it aborts the transfer and waits for
 * it to settle, so the same bytes are never sent twice at once.
 */
export function abortableTransfer<A>(
  start: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, AttachmentUploadError> {
  return Effect.suspend(() => {
    const controller = new AbortController();
    const done = start(controller.signal);
    return Effect.tryPromise({ try: () => done, catch: attachmentUploadError }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => controller.abort()).pipe(
          Effect.andThen(Effect.tryPromise({ try: () => done, catch: attachmentUploadError })),
          Effect.ignore,
        ),
      ),
    );
  });
}

export type AttachmentUploadStatus =
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly reason: string };

/** Equal by key; the request rides along for the upload. */
class UploadKey<Request> implements Equal.Equal {
  readonly id: string;
  readonly request: Request | null;
  constructor(id: string, request: Request | null) {
    this.id = id;
    this.request = request;
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof UploadKey && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

/**
 * Every upload of an attachment, shared by key. Holders keep an upload running, and anyone who
 * needs its result joins the running upload instead of starting another. An upload is
 * interrupted once nothing holds it, and the same attachment does not upload again until that
 * interrupted upload has settled.
 */
export function createAttachmentUploadRegistry<Request>(options: {
  readonly key: (request: Request) => string;
  readonly environmentId: (request: Request) => EnvironmentId;
  /** Uploads running at once against one environment; the rest wait their turn. */
  readonly concurrencyPerEnvironment: number;
  /**
   * Uploads one attachment and returns its uploaded id. Interrupting it must cancel the
   * transfer and wait for it to settle.
   */
  readonly upload: (
    request: Request,
    reportProgress: (progress: number) => void,
  ) => Effect.Effect<string, AttachmentUploadError>;
  /** Saves a finished upload's id; the upload is ready once this succeeds. */
  readonly onUploaded?: (
    request: Request,
    uploadedId: string,
  ) => Effect.Effect<void, AttachmentUploadError>;
  readonly onChange?: (statuses: Readonly<Record<string, AttachmentUploadStatus>>) => void;
}) {
  let statuses: Readonly<Record<string, AttachmentUploadStatus>> = {};
  function setStatus(key: string, status: AttachmentUploadStatus | undefined) {
    const previous = statuses[key];
    if (
      previous === status ||
      (previous?.status === "uploading" &&
        status?.status === "uploading" &&
        previous.progress === status.progress)
    )
      return;
    const next = { ...statuses };
    if (status) next[key] = status;
    else delete next[key];
    statuses = next;
    options.onChange?.(statuses);
  }

  const permits = new Map<EnvironmentId, Semaphore.Semaphore>();
  const permitsFor = (environmentId: EnvironmentId) => {
    let semaphore = permits.get(environmentId);
    if (semaphore === undefined) {
      semaphore = Semaphore.makeUnsafe(options.concurrencyPerEnvironment);
      permits.set(environmentId, semaphore);
    }
    return semaphore;
  };
  const running = new Set<Fiber.Fiber<string, AttachmentUploadError>>();
  // The latest upload per key: a re-added attachment waits for an interrupted one to settle.
  const latest = new Map<string, Fiber.Fiber<string, AttachmentUploadError>>();

  const transfer = (
    key: UploadKey<Request>,
    previous: Fiber.Fiber<string, unknown> | undefined,
  ) => {
    const request = key.request!;
    return (previous === undefined ? Effect.void : Fiber.await(previous)).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (statuses[key.id]?.status !== "uploading") {
            setStatus(key.id, { status: "uploading", progress: 0 });
          }
          return options.upload(request, (progress) =>
            setStatus(key.id, {
              status: "uploading",
              progress: Math.floor(Math.max(0, Math.min(1, progress)) * 20) / 20,
            }),
          );
        }).pipe(Semaphore.withPermits(permitsFor(options.environmentId(request)), 1)),
      ),
      Effect.tap((uploadedId) => options.onUploaded?.(request, uploadedId) ?? Effect.void),
      Effect.tap(() => Effect.sync(() => setStatus(key.id, { status: "ready" }))),
      Effect.tapError((error) =>
        Effect.sync(() => setStatus(key.id, { status: "failed", reason: error.message })),
      ),
    );
  };

  const scope = Scope.makeUnsafe();
  const uploads = Effect.runSync(
    Scope.provide(scope)(
      RcMap.make({
        lookup: Effect.fn("AttachmentUploads.lookup")(function* (key: UploadKey<Request>) {
          setStatus(key.id, { status: "uploading", progress: 0 });
          yield* Effect.addFinalizer(() => Effect.sync(() => setStatus(key.id, undefined)));
          // Starts in the holder's call, so an upload begins as soon as something holds it.
          const fiber = yield* Effect.forkScoped(transfer(key, latest.get(key.id)), {
            startImmediately: true,
          });
          latest.set(key.id, fiber);
          running.add(fiber);
          fiber.addObserver(() => {
            running.delete(fiber);
            if (latest.get(key.id) === fiber) latest.delete(key.id);
          });
          return fiber;
        }),
      }),
    ),
  );
  const keyOf = (request: Request) => new UploadKey(options.key(request), request);

  let disposed = false;
  /** Keeps the request's upload running until the returned release is called. */
  function hold(request: Request): () => void {
    if (disposed) return () => {};
    const holder = Scope.makeUnsafe();
    Effect.runSync(Scope.provide(holder)(RcMap.get(uploads, keyOf(request))));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      Effect.runFork(Scope.close(holder, Exit.void));
    };
  }

  const synced = new Map<string, () => void>();
  let requested: ReadonlyArray<Request> = [];
  /** Holds exactly these uploads; anything no longer requested and held nowhere else stops. */
  function sync(requests: ReadonlyArray<Request>) {
    if (disposed) return;
    requested = requests;
    const keys = new Map(requests.map((request) => [options.key(request), request]));
    for (const [id, release] of synced) {
      if (keys.has(id)) continue;
      synced.delete(id);
      release();
    }
    for (const [id, request] of keys) {
      if (!synced.has(id)) synced.set(id, hold(request));
    }
  }

  /** Drops a failed upload so the next holder starts it again. */
  function invalidate(key: string) {
    Effect.runSync(RcMap.invalidate(uploads, new UploadKey<Request>(key, null)));
  }

  return {
    hold,
    sync,
    invalidate,
    /** Uploads the request, joining its running upload when there is one. */
    upload(request: Request): Effect.Effect<string, AttachmentUploadError> {
      return disposed
        ? Effect.fail(attachmentUploadError(new Error("Upload cancelled.")))
        : RcMap.get(uploads, keyOf(request)).pipe(Effect.flatMap(Fiber.join), Effect.scoped);
    },
    /** Starts a failed upload that `sync` holds again. */
    retry(key: string) {
      if (statuses[key]?.status !== "failed") return;
      invalidate(key);
      synced.get(key)?.();
      synced.delete(key);
      sync(requested);
    },
    /** The upload running or last run for the key, to await it without holding it. */
    current(key: string): Fiber.Fiber<string, AttachmentUploadError> | undefined {
      return latest.get(key);
    },
    status(key: string): AttachmentUploadStatus | undefined {
      return statuses[key];
    },
    async settled() {
      while (running.size > 0) {
        await Effect.runPromise(Fiber.awaitAll([...running]));
      }
    },
    dispose() {
      disposed = true;
      synced.clear();
      Effect.runFork(Scope.close(scope, Exit.void));
      statuses = {};
      options.onChange?.(statuses);
    },
  };
}
