// @effect-diagnostics globalTimers:off -- This protocol broker owns cancellable request deadlines outside the Effect runtime.
import * as NodeCrypto from "node:crypto";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  type DesktopAppActivationFailure,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";

interface PendingActivation {
  readonly request: DesktopAppActivationRequest;
  readonly resolve: (response: DesktopAppActivationResponse) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  dispatchRequestId: string | null;
}

type RendererSender = (request: DesktopAppActivationRequest) => void;

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code,
    message,
  };
}

/** Holds CLI requests until the real desktop renderer is ready to handle them. */
export class DesktopAppActivationBroker {
  readonly #pending = new Map<string, PendingActivation>();
  readonly #requestTimeoutMs: number;
  readonly #activate: () => void;
  #renderer: RendererSender | null = null;
  #closed = false;

  constructor(input: { readonly requestTimeoutMs: number; readonly activate: () => void }) {
    this.#requestTimeoutMs = input.requestTimeoutMs;
    this.#activate = input.activate;
  }

  request(request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> {
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

    // Bound: this private first version only targets an already running,
    // renderer-ready T3 Code window. It never creates or reopens a closed
    // window, so an open-thread request with no renderer fails immediately
    // instead of queueing for a window that may never appear. Check this
    // before superseding so a rejected request cannot disturb pending work.
    if (request.type === "open-thread" && this.#renderer === null) {
      return Promise.resolve(
        failure(
          request.requestId,
          "renderer-unavailable",
          "No running T3 Code window can open that conversation.",
        ),
      );
    }

    // A newer open-thread request replaces older pending open-thread requests:
    // only the latest target matters, and an already-stale navigation must not
    // run. Open-workspace requests keep their original ordering. Settle the
    // whole batch without flushing so a superseded request is never dispatched
    // from inside this loop; the single flush below dispatches the new head.
    if (request.type === "open-thread") {
      for (const pending of this.#pending.values()) {
        if (pending.request.type === "open-thread") {
          this.#settleWithoutFlush(
            failure(
              pending.request.requestId,
              "request-superseded",
              "A newer request replaced this one before it was handled.",
            ),
          );
        }
      }
    }

    const response = new Promise<DesktopAppActivationResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.#settle(
          failure(
            request.requestId,
            "request-timeout",
            "The desktop app did not finish opening the project in time.",
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(request.requestId, {
        request,
        resolve,
        timeout,
        dispatchRequestId: null,
      });
    });

    // Open-thread requests must not raise the previous conversation before the
    // renderer confirms the new target, so they skip activation here and let
    // complete() decide once the target is validated. Workspace behavior stays
    // exactly as before: focus immediately, then queue until the renderer is
    // ready.
    if (request.type !== "open-thread") {
      this.#activate();
    }
    this.#flush();
    return response;
  }

  /** True only while the request is pending and has already reached the renderer. */
  isRequestActive(dispatchRequestId: string): boolean {
    return this.#findPendingDispatch(dispatchRequestId) !== undefined;
  }

  registerRenderer(send: RendererSender): void {
    this.#renderer = send;
    this.#flush();
  }

  clearRenderer(): void {
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      // A lost renderer invalidates every open-thread target, whether it was
      // already dispatched or still queued, because a later reopened window
      // must not navigate to a conversation the user asked for before it went
      // away. Dispatched workspace requests fail for the same reason, while
      // undispatched workspace requests keep queueing until a renderer returns.
      if (pending.request.type === "open-thread" || pending.dispatchRequestId !== null) {
        this.#settle(
          failure(
            pending.request.requestId,
            "renderer-unavailable",
            "The T3 Code window closed before it opened the project.",
          ),
        );
      }
    }
  }

  complete(response: DesktopAppActivationResponse): void {
    const pending = this.#findPendingDispatch(response.requestId);
    if (pending === undefined) return;

    if (response.ok && pending.request.type === "open-thread") {
      // Raise the window only after the renderer confirms the exact target this
      // broker dispatched. A success for another thread or environment must not
      // focus the window, and late, cancelled, superseded or timed-out responses
      // no longer have a pending request and never activate.
      if (
        response.environmentId === pending.request.environmentId &&
        response.threadId === pending.request.threadId
      ) {
        this.#activate();
        this.#settle({ ...response, requestId: pending.request.requestId });
        return;
      }
      this.#settle(
        failure(
          pending.request.requestId,
          "thread-open-failed",
          "The desktop app did not open the requested conversation.",
        ),
      );
      return;
    }
    this.#settle({ ...response, requestId: pending.request.requestId });
  }

  cancel(requestId: string): void {
    this.#settle(
      failure(requestId, "renderer-unavailable", "The command closed before T3 Code was ready."),
    );
  }

  close(): void {
    this.#closed = true;
    this.#renderer = null;
    for (const pending of this.#pending.values()) {
      this.#settle(
        failure(pending.request.requestId, "renderer-unavailable", "T3 Code is shutting down."),
      );
    }
  }

  #flush(): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    if ([...this.#pending.values()].some((pending) => pending.dispatchRequestId !== null)) return;

    for (const pending of this.#pending.values()) {
      if (pending.dispatchRequestId !== null) continue;
      try {
        // This opaque per-dispatch value travels in renderer requestId;
        // complete() restores the stored client requestId before resolving.
        const dispatchRequestId = NodeCrypto.randomUUID();
        pending.dispatchRequestId = dispatchRequestId;
        renderer({ ...pending.request, requestId: dispatchRequestId });
      } catch {
        pending.dispatchRequestId = null;
        // A renderer that throws on send is gone for this request: cancel
        // open-thread work instead of requeueing it. clearRenderer drops the
        // failed sender before it settles and flushes, so this cannot recurse.
        // Undispatched workspace requests still requeue as before.
        this.clearRenderer();
      }
      return;
    }
  }

  #findPendingDispatch(dispatchRequestId: string): PendingActivation | undefined {
    for (const pending of this.#pending.values()) {
      if (pending.dispatchRequestId === dispatchRequestId) return pending;
    }
    return undefined;
  }

  #settle(response: DesktopAppActivationResponse): void {
    this.#settleWithoutFlush(response);
    this.#flush();
  }

  #settleWithoutFlush(response: DesktopAppActivationResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(response.requestId);
    pending.resolve(response);
  }
}
