import type { PreviewAutomationRequest, PreviewAutomationResponse } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

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
): NonNullable<PreviewAutomationResponse["error"]> {
  if (error instanceof Error) {
    const detail =
      "detail" in error && (error as { detail?: unknown }).detail !== undefined
        ? (error as { detail?: unknown }).detail
        : undefined;
    return {
      _tag: error.name.startsWith("PreviewAutomation")
        ? error.name
        : "PreviewAutomationExecutionError",
      message: error.message,
      ...(detail === undefined ? {} : { detail }),
    };
  }
  return {
    _tag: "PreviewAutomationExecutionError",
    message: String(error),
  };
}

export function createPreviewAutomationRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AutomationRequestResult<E>>;
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
            error: serializePreviewAutomationError(error),
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
