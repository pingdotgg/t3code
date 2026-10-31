import type { NativeReviewDiffSource } from "./nativeReviewDiffTypes";
import { diffHighlightTraceId, traceDiffHighlight } from "./nativeReviewDiffTrace";

const MAX_SOURCE_FILES = 4;
// Bound retained UTF-16 text across files without discarding an already-fetched
// authoritative source just because it is large. Provider response limits still apply.
const MAX_CACHED_SOURCE_CHARACTERS = 8_000_000;

function isWeakKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function permanentSourceFailureReason(error: unknown): string | undefined {
  for (let depth = 0; depth < 8 && typeof error === "object" && error !== null; depth++) {
    const reason = "reason" in error ? error.reason : undefined;
    const name = "name" in error ? error.name : undefined;
    // Defect serialization preserves error names and causes, but drops custom fields.
    if (name === "GitCafeDiffSourceUnavailableError") return "gitcafe-source-unavailable";
    if (name === "GitHubDiffFileContentsUnavailableError") return "github-source-unavailable";
    for (const permanent of [
      "provider-unsupported",
      "unsupported",
      "oversized",
      "binary",
      "not-found",
    ]) {
      if (permanent === reason) return permanent;
    }
    if ("status" in error && error.status === 413) return "http-413";
    if ("status" in error && error.status === 501) return "http-501";
    // Older servers have no structured reason for an unsupported contents RPC.
    if (
      "detail" in error &&
      error.detail === "This host cannot expand unchanged pull request lines."
    )
      return "legacy-host-unsupported";
    error = "cause" in error ? error.cause : undefined;
  }
  return undefined;
}

function waitForSource(
  promise: Promise<NativeReviewDiffSource | null>,
  signal?: AbortSignal,
): Promise<NativeReviewDiffSource | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(null);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (source) => {
        signal.removeEventListener("abort", abort);
        resolve(source);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function createNativeReviewDiffSourceLoader<FileId>(
  fetchSource: (fileId: FileId) => Promise<NativeReviewDiffSource>,
) {
  const cached = new Map<FileId, NativeReviewDiffSource>();
  let cachedCharacters = 0;
  type Failure = { attempts: number; unavailable: boolean };
  // Request closures can own parsed rows; failed versions must not retain them.
  const objectFailures = new WeakMap<object, Failure>();
  const primitiveFailures = new Map<FileId, Failure>();
  const pending = new Map<
    FileId,
    {
      readonly promise: Promise<NativeReviewDiffSource | null>;
      readonly subscribers: Set<AbortSignal | undefined>;
    }
  >();
  // RPC commands cannot abort a request already sent. Serialize source fetches
  // and drop queued requests whose viewports have all been cancelled.
  let tail = Promise.resolve();
  const loader = diffHighlightTraceId(cached);

  return async (fileId: FileId, signal?: AbortSignal) => {
    const file = diffHighlightTraceId(fileId);
    const failure = (isWeakKey(fileId)
      ? objectFailures.get(fileId)
      : primitiveFailures.get(fileId)) ?? { attempts: 0, unavailable: false };
    if (signal?.aborted || failure.unavailable) {
      traceDiffHighlight("source-skip", {
        loader,
        file,
        aborted: signal?.aborted ?? false,
        unavailable: failure.unavailable,
      });
      return null;
    }
    if (cached.has(fileId)) {
      traceDiffHighlight("source-cache", { loader, file });
      const source = cached.get(fileId)!;
      cached.delete(fileId);
      cached.set(fileId, source);
      return source;
    }
    let request = pending.get(fileId);
    if (!request) {
      traceDiffHighlight("source-queued", { loader, file, pending: pending.size });
      const subscribers = new Set<AbortSignal | undefined>();
      const promise = tail
        .then(async () => {
          if ([...subscribers].every((subscriber) => subscriber?.aborted)) {
            // A cancelled request must stop being shareable before its promise settles.
            pending.delete(fileId);
            traceDiffHighlight("source-dropped", { loader, file });
            return null;
          }
          const attempt = ++failure.attempts;
          if (isWeakKey(fileId)) objectFailures.set(fileId, failure);
          else primitiveFailures.set(fileId, failure);
          traceDiffHighlight("source-start", { loader, file, attempt });
          try {
            const contents = await fetchSource(fileId);
            traceDiffHighlight("source-result", {
              loader,
              file,
              oldCharacters: contents.oldContents.length,
              newCharacters: contents.newContents.length,
            });
            const characters = contents.oldContents.length + contents.newContents.length;
            if (isWeakKey(fileId)) objectFailures.delete(fileId);
            else primitiveFailures.delete(fileId);
            if (characters <= MAX_CACHED_SOURCE_CHARACTERS) {
              cached.set(fileId, contents);
              cachedCharacters += characters;
              while (
                cached.size > MAX_SOURCE_FILES ||
                cachedCharacters > MAX_CACHED_SOURCE_CHARACTERS
              ) {
                const oldest = cached.keys().next().value!;
                const source = cached.get(oldest)!;
                cachedCharacters -= source.oldContents.length + source.newContents.length;
                cached.delete(oldest);
              }
            }
            return contents;
          } catch (error) {
            const reason = permanentSourceFailureReason(error);
            const permanent = reason !== undefined;
            traceDiffHighlight("source-error", {
              loader,
              file,
              attempt,
              permanent,
              reason: reason ?? "transient",
            });
            if (permanent) {
              failure.unavailable = true;
              traceDiffHighlight("source-unavailable", {
                loader,
                file,
                reason: "permanent-error",
              });
              return null;
            }
            // Only a later viewport request retries; never loop inside this request.
            throw error;
          }
        })
        .finally(() => {
          if (pending.get(fileId) === request) pending.delete(fileId);
        });
      tail = promise.then(
        () => {},
        () => {},
      );
      request = { promise, subscribers };
      pending.set(fileId, request);
    } else traceDiffHighlight("source-shared", { loader, file });
    request.subscribers.add(signal);
    try {
      return await waitForSource(request.promise, signal);
    } finally {
      if (signal?.aborted) traceDiffHighlight("source-wait-aborted", { loader, file });
      request.subscribers.delete(signal);
    }
  };
}
