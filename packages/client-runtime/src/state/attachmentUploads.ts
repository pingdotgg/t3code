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
 * interrupted once nothing holds it.
 */
export function createAttachmentUploadRegistry<Request>(options: {
  readonly key: (request: Request) => string;
  readonly environmentId: (request: Request) => EnvironmentId;
  /** Uploads running at once against one environment; the rest wait their turn. */
  readonly concurrencyPerEnvironment: number;
  /** Uploads one attachment and returns its uploaded id; interrupting it cancels the transfer. */
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
  const rejected = new Map<string, string>();
  let statuses: Readonly<Record<string, AttachmentUploadStatus>> = {};
  function setStatus(key: string, status: AttachmentUploadStatus | undefined) {
    const reason = rejected.get(key);
    if (status !== undefined && reason !== undefined) status = { status: "failed", reason };
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
  const running = new Map<string, Fiber.Fiber<string, AttachmentUploadError>>();
  // The entry that owns each key's status: an invalidated entry finishing or closing late must
  // not overwrite or clear the status of the entry that replaced it.
  const owners = new Map<string, object>();
  const setOwnStatus = (owner: object, key: string, status: AttachmentUploadStatus | undefined) => {
    if (owners.get(key) === owner) setStatus(key, status);
  };

  const transfer = (key: UploadKey<Request>, owner: object) => {
    const request = key.request!;
    return Effect.suspend(() => {
      const reason = rejected.get(key.id);
      if (reason !== undefined) return Effect.fail(attachmentUploadError(new Error(reason)));
      if (statuses[key.id]?.status !== "uploading") {
        setOwnStatus(owner, key.id, { status: "uploading", progress: 0 });
      }
      return options.upload(request, (progress) =>
        setOwnStatus(owner, key.id, {
          status: "uploading",
          progress: Math.floor(Math.max(0, Math.min(1, progress)) * 20) / 20,
        }),
      );
    }).pipe(
      Semaphore.withPermits(permitsFor(options.environmentId(request)), 1),
      Effect.tap((uploadedId) => options.onUploaded?.(request, uploadedId) ?? Effect.void),
      Effect.tap(() => Effect.sync(() => setOwnStatus(owner, key.id, { status: "ready" }))),
      Effect.tapError((error) =>
        Effect.sync(() => setOwnStatus(owner, key.id, { status: "failed", reason: error.message })),
      ),
    );
  };

  const scope = Scope.makeUnsafe();
  const uploads = Effect.runSync(
    Scope.provide(scope)(
      RcMap.make({
        lookup: Effect.fn("AttachmentUploads.lookup")(function* (key: UploadKey<Request>) {
          const owner = {};
          owners.set(key.id, owner);
          setStatus(key.id, { status: "uploading", progress: 0 });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              setOwnStatus(owner, key.id, undefined);
              if (owners.get(key.id) === owner) owners.delete(key.id);
            }),
          );
          // Starts in the holder's call, so an upload begins as soon as something holds it.
          const fiber = yield* Effect.forkScoped(transfer(key, owner), {
            startImmediately: true,
          });
          running.set(key.id, fiber);
          fiber.addObserver(() => {
            if (running.get(key.id) === fiber) running.delete(key.id);
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

  /** Drops the key's upload and starts it again for whatever `sync` holds. */
  function restart(key: string) {
    rejected.delete(key);
    invalidate(key);
    synced.get(key)?.();
    synced.delete(key);
    sync(requested);
  }

  return {
    hold,
    sync,
    invalidate,
    restart,
    /** Keeps a server-rejected upload failed across draft moves until an explicit retry. */
    markFailed(key: string, reason: string) {
      if (disposed) return;
      rejected.set(key, reason);
      setStatus(key, { status: "failed", reason });
      const fiber = running.get(key);
      if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber));
      invalidate(key);
    },
    /**
     * Uploads the request, joining its running or finished upload. A failed one starts again,
     * so a retrying send never just rejoins the failure.
     */
    upload(request: Request): Effect.Effect<string, AttachmentUploadError> {
      return Effect.suspend(() => {
        if (disposed) return Effect.fail(attachmentUploadError(new Error("Upload cancelled.")));
        const key = options.key(request);
        if (statuses[key]?.status === "failed") restart(key);
        return RcMap.get(uploads, keyOf(request)).pipe(Effect.flatMap(Fiber.join), Effect.scoped);
      });
    },
    /** Starts a failed upload that `sync` holds again. */
    retry(key: string) {
      if (statuses[key]?.status === "failed") restart(key);
    },
    /** The key's running upload, to await it without holding it. */
    current(key: string): Fiber.Fiber<string, AttachmentUploadError> | undefined {
      return running.get(key);
    },
    status(key: string): AttachmentUploadStatus | undefined {
      return statuses[key];
    },
    async settled() {
      while (running.size > 0) {
        await Effect.runPromise(Fiber.awaitAll([...running.values()]));
      }
    },
    dispose() {
      disposed = true;
      rejected.clear();
      synced.clear();
      Effect.runFork(Scope.close(scope, Exit.void));
      statuses = {};
      options.onChange?.(statuses);
    },
  };
}
