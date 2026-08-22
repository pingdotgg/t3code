import type {
  PreviewAutomationHost,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  PreviewAutomationHostDeadlineExceededError,
  PreviewAutomationOperationError,
  type PreviewAutomationOperationContext,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

type AutomationStreamResult<E> = AsyncResult.AsyncResult<PreviewAutomationStreamEvent, E>;

export const PREVIEW_AUTOMATION_RESPONSE_GRACE_MS = 250;

export const previewAutomationExecutionBudget = (
  timeoutMs: number,
  responseGraceMs = PREVIEW_AUTOMATION_RESPONSE_GRACE_MS,
): number => Math.min(timeoutMs, Math.max(responseGraceMs * 2, timeoutMs - responseGraceMs));

export const previewAutomationRemainingBudget = (
  operationDeadline: number,
  requestedTimeoutMs: number,
  now = Date.now(),
): number => Math.min(requestedTimeoutMs, operationDeadline - now);

export const previewAutomationRemainingBestEffortBudget = (
  operationDeadline: number,
  requestedTimeoutMs: number,
  now = Date.now(),
): number =>
  Math.max(0, previewAutomationRemainingBudget(operationDeadline, requestedTimeoutMs, now));

export const previewAutomationInputWithRemainingTimeout = <Input extends object>(
  input: Input & { readonly timeoutMs?: number | undefined },
  requestTimeoutMs: number,
  remainingOperationBudget: (requestedTimeoutMs: number) => number,
): Input & { readonly timeoutMs: number } => ({
  ...input,
  timeoutMs: remainingOperationBudget(input.timeoutMs ?? requestTimeoutMs),
});

const handleWithinResponseBudget = (
  request: PreviewAutomationRequest,
  environmentId: PreviewAutomationHost["environmentId"],
  handle: Promise<unknown>,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = previewAutomationExecutionBudget(request.timeoutMs);
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new PreviewAutomationHostDeadlineExceededError({
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId: request.tabId ?? null,
          timeoutMs,
        }),
      );
    }, timeoutMs);
    handle.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });

export function serializePreviewAutomationError(
  error: unknown,
  context: PreviewAutomationOperationContext,
): NonNullable<PreviewAutomationResponse["error"]> {
  return serializePreviewAutomationHostError(
    PreviewAutomationOperationError.fromCause({ ...context, cause: error }),
  );
}

export function createPreviewAutomationRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AutomationStreamResult<E>>;
  readonly clientId: PreviewAutomationHost["clientId"];
  readonly connectionAtom: Atom.Writable<PreviewAutomationStreamEvent["connectionId"] | null>;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly requestHandlerAtom: Atom.Atom<{
    readonly handle: (request: PreviewAutomationRequest) => Promise<unknown>;
  }>;
  readonly respond: (response: PreviewAutomationResponse) => Promise<unknown>;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    get.mount(options.connectionAtom);
    get.mount(options.requestHandlerAtom);
    let disposed = false;
    let activeConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let connectionExplicitlyAnnounced = false;
    let reportedConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let requestsVersion = 0;

    const consume = (result: AutomationStreamResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") {
        activeConnectionId = event.connectionId;
        connectionExplicitlyAnnounced = true;
      } else if (activeConnectionId === null) {
        activeConnectionId = event.connectionId;
      } else if (activeConnectionId !== event.connectionId) {
        if (connectionExplicitlyAnnounced) return;
        activeConnectionId = event.connectionId;
      }
      if (reportedConnectionId !== event.connectionId) {
        reportedConnectionId = event.connectionId;
        get.set(options.connectionAtom, event.connectionId);
      }
      if (event.type === "connected") {
        return;
      }
      const request = event.request;
      const handle = get.once(options.requestHandlerAtom).handle(request);
      void handleWithinResponseBudget(request, options.environmentId, handle).then(
        (value) =>
          options.respond({
            clientId: options.clientId,
            connectionId: event.connectionId,
            requestId: request.requestId,
            ok: true,
            ...(value === undefined ? {} : { result: value }),
          }),
        (error) =>
          options.respond({
            clientId: options.clientId,
            connectionId: event.connectionId,
            requestId: request.requestId,
            ok: false,
            error: serializePreviewAutomationError(error, {
              requestId: request.requestId,
              operation: request.operation,
              environmentId: options.environmentId,
              threadId: request.threadId,
              tabId: request.tabId ?? null,
            }),
          }),
      );
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initialRequest = get.once(options.requestsAtom);
    if (AsyncResult.isSuccess(initialRequest)) {
      activeConnectionId = initialRequest.value.connectionId;
      connectionExplicitlyAnnounced = initialRequest.value.type === "connected";
      if (initialRequest.value.type === "connected") {
        reportedConnectionId = initialRequest.value.connectionId;
        get.set(options.connectionAtom, initialRequest.value.connectionId);
      }
    }
    get.subscribe(options.requestsAtom, (result) => {
      requestsVersion += 1;
      consume(result);
    });
    queueMicrotask(() => {
      const initialConnectionWasSkipped =
        AsyncResult.isSuccess(initialRequest) &&
        initialRequest.value.connectionId === activeConnectionId &&
        initialRequest.value.connectionId !== reportedConnectionId;
      if (!disposed && (requestsVersion === 0 || initialConnectionWasSkipped)) {
        consume(initialRequest);
      }
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
