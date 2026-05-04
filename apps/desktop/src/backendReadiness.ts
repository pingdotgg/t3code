export interface WaitForHttpReadyOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly path?: string;
  readonly isReady?: (response: Response) => boolean;
}

/**
 * Unauthenticated 200 from the T3 HTTP server. Avoids probing `/`, which returns 302 to the Vite
 * dev URL when `devUrl` is configured — `response.ok` is false for redirects, so readiness would
 * never succeed in desktop dev.
 */
export const T3_BACKEND_READINESS_PATH = "/.well-known/t3/environment";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;

export class BackendReadinessAbortedError extends Error {
  constructor() {
    super("Backend readiness wait was aborted.");
    this.name = "BackendReadinessAbortedError";
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new BackendReadinessAbortedError());
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(new BackendReadinessAbortedError());
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isBackendReadinessAborted(error: unknown): error is BackendReadinessAbortedError {
  return error instanceof BackendReadinessAbortedError;
}

export async function waitForHttpReady(
  baseUrl: string,
  options?: WaitForHttpReadyOptions,
): Promise<void> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const readinessPath = options?.path ?? T3_BACKEND_READINESS_PATH;
  const isReady = options?.isReady ?? ((response: Response) => response.ok);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) {
      throw new BackendReadinessAbortedError();
    }

    const requestController = new AbortController();
    const requestTimeout = setTimeout(() => {
      requestController.abort();
    }, requestTimeoutMs);
    const abortRequest = () => {
      requestController.abort();
    };
    signal?.addEventListener("abort", abortRequest, { once: true });

    try {
      const response = await fetchImpl(new URL(readinessPath, baseUrl).toString(), {
        redirect: "manual",
        signal: requestController.signal,
      });
      if (isReady(response)) {
        return;
      }
    } catch (error) {
      if (isBackendReadinessAborted(error)) {
        throw error;
      }
      if (signal?.aborted) {
        throw new BackendReadinessAbortedError();
      }
      // Retry until the backend becomes reachable or the deadline expires.
    } finally {
      clearTimeout(requestTimeout);
      signal?.removeEventListener("abort", abortRequest);
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for backend readiness at ${baseUrl}.`);
    }

    await delay(intervalMs, signal);
  }
}
