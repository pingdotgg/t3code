import type { NativeReviewDiffSource } from "./nativeReviewDiffTypes";
import { diffHighlightTraceId, traceDiffHighlight } from "./nativeReviewDiffTrace";

const MAX_SOURCE_FILES = 4;
const MAX_SOURCE_CHARACTERS = 500_000;
const MAX_SOURCE_ATTEMPTS = 2;

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

export function createNativeReviewDiffSourceLoader(
  fetchSource: (fileId: string) => Promise<NativeReviewDiffSource>,
) {
  const cached = new Map<string, NativeReviewDiffSource>();
  const unavailable = new Set<string>();
  const attempts = new Map<string, number>();
  const pending = new Map<
    string,
    {
      readonly promise: Promise<NativeReviewDiffSource | null>;
      readonly subscribers: Set<AbortSignal | undefined>;
    }
  >();
  // RPC commands cannot abort a request already sent. Serialize source fetches
  // and drop queued requests whose viewports have all been cancelled.
  let tail = Promise.resolve();
  const loader = diffHighlightTraceId(cached);

  return async (fileId: string, signal?: AbortSignal) => {
    const file = diffHighlightTraceId(fileId);
    if (signal?.aborted || unavailable.has(fileId)) {
      traceDiffHighlight("source-skip", {
        loader,
        file,
        aborted: signal?.aborted ?? false,
        unavailable: unavailable.has(fileId),
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
            traceDiffHighlight("source-dropped", { loader, file });
            return null;
          }
          const attempt = (attempts.get(fileId) ?? 0) + 1;
          attempts.set(fileId, attempt);
          traceDiffHighlight("source-start", { loader, file, attempt });
          try {
            const contents = await fetchSource(fileId);
            traceDiffHighlight("source-result", {
              loader,
              file,
              oldCharacters: contents.oldContents.length,
              newCharacters: contents.newContents.length,
            });
            if (contents.oldContents.length + contents.newContents.length > MAX_SOURCE_CHARACTERS) {
              unavailable.add(fileId);
              traceDiffHighlight("source-unavailable", { loader, file, reason: "oversized" });
              return null;
            }
            cached.set(fileId, contents);
            attempts.delete(fileId);
            while (cached.size > MAX_SOURCE_FILES) cached.delete(cached.keys().next().value!);
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
            if (permanent || attempt >= MAX_SOURCE_ATTEMPTS) {
              unavailable.add(fileId);
              traceDiffHighlight("source-unavailable", {
                loader,
                file,
                reason: permanent ? "permanent-error" : "attempts",
              });
              return null;
            }
            // Only a later viewport request retries; never loop inside this request.
            throw error;
          }
        })
        .finally(() => pending.delete(fileId));
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
