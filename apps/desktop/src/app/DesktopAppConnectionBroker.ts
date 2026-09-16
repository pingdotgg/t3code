// @effect-diagnostics globalTimers:off -- This protocol broker owns cancellable request deadlines outside the Effect runtime.
import {
  type DesktopAppConnectionCompletion,
  type DesktopAppConnectionDispatch,
  type DesktopAppConnectionRequest,
  type DesktopAppConnectionResponse,
  desktopAppConnectionFailure as failure,
} from "@t3tools/contracts";

interface PendingConnectionRequest {
  readonly request: DesktopAppConnectionRequest;
  readonly resolve: (response: DesktopAppConnectionResponse) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  /** Token minted when the request was sent to the renderer; null while queued. */
  dispatchId: string | null;
}

export interface ConnectionRendererSender {
  readonly dispatch: (dispatch: DesktopAppConnectionDispatch) => void;
  readonly cancel: (dispatchId: string) => void;
}

/**
 * Forwards connection-bridge requests from the control socket to the renderer
 * concurrently. Requests queue until a renderer registers, fail when that
 * renderer goes away, and a completion only settles the dispatch it belongs to.
 */
export class DesktopAppConnectionBroker {
  readonly #pending = new Map<string, PendingConnectionRequest>();
  readonly #requestTimeoutMs: number;
  readonly #maxPending: number;
  readonly #nextDispatchId: () => string;
  #renderer: ConnectionRendererSender | null = null;
  #closed = false;

  constructor(input: {
    readonly requestTimeoutMs: number;
    readonly maxPending: number;
    readonly nextDispatchId?: () => string;
  }) {
    this.#requestTimeoutMs = input.requestTimeoutMs;
    this.#maxPending = input.maxPending;
    let counter = 0;
    this.#nextDispatchId = input.nextDispatchId ?? (() => `dispatch-${++counter}`);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  request(request: DesktopAppConnectionRequest): Promise<DesktopAppConnectionResponse> {
    if (this.#closed) {
      return Promise.resolve(
        failure(request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
    if (this.#pending.has(request.requestId)) {
      return Promise.resolve(
        failure(request.requestId, "invalid-request", "The request id is already in use."),
      );
    }
    if (this.#pending.size >= this.#maxPending) {
      return Promise.resolve(
        failure(
          request.requestId,
          "too-many-requests",
          "T3 Code has too many connection requests in flight.",
        ),
      );
    }

    const response = new Promise<DesktopAppConnectionResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.#abandon(
          request.requestId,
          failure(
            request.requestId,
            "request-timeout",
            "The desktop app did not answer the connection request in time.",
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(request.requestId, { request, resolve, timeout, dispatchId: null });
    });

    this.#flush();
    return response;
  }

  /** Re-registering the same renderer only swaps the sender; in-flight dispatches keep their tokens. */
  registerRenderer(sender: ConnectionRendererSender): void {
    this.#renderer = sender;
    this.#flush();
  }

  clearRenderer(): void {
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      if (pending.dispatchId !== null) {
        this.#settle(
          pending.request.requestId,
          failure(
            pending.request.requestId,
            "renderer-unavailable",
            "The T3 Code window went away before it answered the connection request.",
          ),
        );
      }
    }
  }

  /** Completions are only honored for the dispatch token the request currently carries. */
  complete(completion: DesktopAppConnectionCompletion): void {
    const requestId = completion.response.requestId;
    const pending = this.#pending.get(requestId);
    if (!pending || pending.dispatchId !== completion.dispatchId) return;
    this.#settle(requestId, completion.response);
  }

  /**
   * Cancels by request identity, not id: a duplicate-id request that was
   * rejected (or a socket that already got its answer) must not be able to
   * cancel another caller's still-valid request.
   */
  cancel(request: DesktopAppConnectionRequest): void {
    const pending = this.#pending.get(request.requestId);
    if (pending === undefined || pending.request !== request) return;
    this.#abandon(
      request.requestId,
      failure(
        request.requestId,
        "renderer-unavailable",
        "The client closed before T3 Code answered.",
      ),
    );
  }

  close(): void {
    this.#closed = true;
    const renderer = this.#renderer;
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      if (pending.dispatchId !== null && renderer !== null) {
        try {
          renderer.cancel(pending.dispatchId);
        } catch {
          // The renderer is going away with us.
        }
      }
      this.#settle(
        pending.request.requestId,
        failure(pending.request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
  }

  #flush(): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    for (const pending of this.#pending.values()) {
      if (pending.dispatchId !== null) continue;
      const dispatchId = this.#nextDispatchId();
      try {
        pending.dispatchId = dispatchId;
        renderer.dispatch({ dispatchId, request: pending.request });
      } catch {
        pending.dispatchId = null;
        this.#renderer = null;
        return;
      }
    }
  }

  /** Settles locally and tells the renderer to stop work it may still be doing. */
  #abandon(requestId: string, response: DesktopAppConnectionResponse): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    const dispatchId = pending.dispatchId;
    this.#settle(requestId, response);
    if (dispatchId !== null && this.#renderer !== null) {
      try {
        this.#renderer.cancel(dispatchId);
      } catch {
        this.#renderer = null;
      }
    }
  }

  #settle(requestId: string, response: DesktopAppConnectionResponse): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(requestId);
    pending.resolve(response);
  }
}
