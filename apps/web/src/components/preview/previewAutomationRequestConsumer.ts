import type {
  PreviewAutomationOwner,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  PreviewAutomationOperationError,
  type PreviewAutomationOperationContext,
  serializePreviewAutomationOwnerError,
} from "./previewAutomationErrors";

type AutomationRequestResult<E> = AsyncResult.AsyncResult<PreviewAutomationRequest, E>;
type AutomationRequestHandler = (request: PreviewAutomationRequest) => Promise<unknown>;

export function createLatestPreviewAutomationRequestHandler(initial: AutomationRequestHandler): {
  readonly set: (handler: AutomationRequestHandler) => void;
  readonly handle: AutomationRequestHandler;
} {
  let current = initial;
  return {
    set: (handler) => {
      current = handler;
    },
    handle: (request) => current(request),
  };
}

export function serializePreviewAutomationError(
  error: unknown,
  context: PreviewAutomationOperationContext,
): NonNullable<PreviewAutomationResponse["error"]> {
  return serializePreviewAutomationOwnerError(
    PreviewAutomationOperationError.fromCause({ ...context, cause: error }),
  );
}

export function createPreviewAutomationRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AutomationRequestResult<E>>;
  readonly environmentId: PreviewAutomationOwner["environmentId"];
  readonly handleRequest: (request: PreviewAutomationRequest) => Promise<unknown>;
  readonly respond: (response: PreviewAutomationResponse) => Promise<unknown>;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    let disposed = false;
    let requestsVersion = 0;

    const consume = (result: AutomationRequestResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const request = result.value;
      void options.handleRequest(request).then(
        (value) =>
          options.respond({
            requestId: request.requestId,
            ok: true,
            ...(value === undefined ? {} : { result: value }),
          }),
        (error) =>
          options.respond({
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
    get.subscribe(options.requestsAtom, (result) => {
      requestsVersion += 1;
      consume(result);
    });
    queueMicrotask(() => {
      if (!disposed && requestsVersion === 0) consume(initialRequest);
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
