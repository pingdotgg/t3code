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
    const explicitDetail =
      "detail" in error && (error as { detail?: unknown }).detail !== undefined
        ? (error as { detail?: unknown }).detail
        : undefined;
    const structuralDetail =
      "_tag" in error &&
      typeof (error as { _tag?: unknown })._tag === "string" &&
      (error as { _tag: string })._tag.startsWith("PreviewAutomation")
        ? Object.fromEntries(
            Object.entries(error).filter(
              ([key]) =>
                key !== "_tag" &&
                key !== "cause" &&
                key !== "name" &&
                key !== "message" &&
                key !== "stack" &&
                key !== "detail" &&
                key !== "responseTag",
            ),
          )
        : undefined;
    const detail = explicitDetail ?? structuralDetail;
    const responseTag =
      "responseTag" in error &&
      typeof (error as { responseTag?: unknown }).responseTag === "string" &&
      (error as { responseTag: string }).responseTag.startsWith("PreviewAutomation")
        ? (error as { responseTag: string }).responseTag
        : undefined;
    return {
      _tag:
        responseTag ??
        (error.name.startsWith("PreviewAutomation")
          ? error.name
          : "PreviewAutomationExecutionError"),
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
