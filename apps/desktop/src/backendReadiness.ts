export interface WaitForHttpReadyOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

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
      const response = await fetchImpl(`${baseUrl}/api/auth/session`, {
        redirect: "manual",
        signal: requestController.signal,
      });
      if (response.ok) {
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
