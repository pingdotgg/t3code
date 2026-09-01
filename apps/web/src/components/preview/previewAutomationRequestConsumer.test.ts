import {
  EnvironmentId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  PreviewTabId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  PreviewAutomationDesktopFailureError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import {
  createPreviewAutomationRequestConsumerAtom,
  serializePreviewAutomationError,
} from "./previewAutomationRequestConsumer";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const tabId = PreviewTabId.make("tab-1");
const clientId = "client-1";
const connectionId = "connection-1";

const request = (
  requestId: string,
  overrides: Partial<PreviewAutomationRequest> = {},
): PreviewAutomationRequest => ({
  requestId,
  threadId,
  operation: "status",
  input: {},
  timeoutMs: 15_000,
  ...overrides,
});

const requestEvent = (
  requestId: string,
  overrides: Partial<PreviewAutomationRequest> = {},
  eventConnectionId = connectionId,
): PreviewAutomationStreamEvent => ({
  type: "request",
  connectionId: eventConnectionId,
  request: request(requestId, overrides),
});

const consumerState = (handleRequest: (request: PreviewAutomationRequest) => Promise<unknown>) => ({
  connectionAtom: Atom.make<string | null>(null),
  requestHandlerAtom: Atom.make({ handle: handleRequest }),
});

describe("previewAutomationRequestConsumer", () => {
  it("acknowledges a replacement stream before consuming requests from it", async () => {
    const requestsAtom = Atom.make(
      AsyncResult.success<PreviewAutomationStreamEvent, Error>({
        type: "connected",
        connectionId,
      }),
    );
    const handleRequest = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      respond,
      label: "test:preview-automation-connected",
    });
    const registry = AtomRegistry.make();

    registry.mount(consumerAtom);
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-after-connect")));

    await vi.waitFor(() => expect(registry.get(state.connectionAtom)).toBe(connectionId));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(handleRequest).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it("drops late requests from an older stream generation", async () => {
    const requestsAtom = Atom.make(
      AsyncResult.success<PreviewAutomationStreamEvent, Error>({
        type: "connected",
        connectionId: "connection-2",
      }),
    );
    const handleRequest = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      respond,
      label: "test:preview-automation-stale-generation",
    });
    const registry = AtomRegistry.make();

    registry.mount(consumerAtom);
    registry.set(
      requestsAtom,
      AsyncResult.success(requestEvent("request-stale", {}, "connection-1")),
    );

    await vi.waitFor(() => expect(registry.get(state.connectionAtom)).toBe("connection-2"));
    expect(handleRequest).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("consumes every request emitted before React can render", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const handleRequest = vi.fn(async (value: PreviewAutomationRequest) => ({
      requestId: value.requestId,
    }));
    const responses: PreviewAutomationResponse[] = [];
    const respond = vi.fn(async (response: PreviewAutomationResponse) => {
      responses.push(response);
    });
    const state = consumerState(handleRequest);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      respond,
      label: "test:preview-automation-consumer",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-1")));
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-2")));

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(handleRequest.mock.calls.map(([value]) => value.requestId)).toEqual([
      "request-1",
      "request-2",
    ]);
    expect(responses.map((response) => response.requestId)).toEqual(["request-1", "request-2"]);
    registry.dispose();
  });

  it("uses the latest request handler without rebuilding the stream consumer", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const firstHandler = vi.fn(async () => "first");
    const secondHandler = vi.fn(async () => "second");
    const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
    const state = consumerState(firstHandler);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      respond,
      label: "test:preview-automation-latest-handler",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-first")));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    registry.set(state.requestHandlerAtom, { handle: secondHandler });
    registry.set(requestsAtom, AsyncResult.success(requestEvent("request-second")));

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls.map(([response]) => response.result)).toEqual(["first", "second"]);
    registry.dispose();
  });

  it("consumes a request that arrived immediately before the consumer mounted", async () => {
    const requestsAtom = Atom.make(
      AsyncResult.success<PreviewAutomationStreamEvent, Error>(requestEvent("request-ready")),
    );
    const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
    const state = consumerState(async () => undefined);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      respond,
      label: "test:preview-automation-initial-request",
    });
    const registry = AtomRegistry.make();

    registry.mount(consumerAtom);

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith({
      clientId,
      connectionId,
      requestId: "request-ready",
      ok: true,
    });
    registry.dispose();
  });

  it("preserves tagged automation errors and their structured diagnostics", () => {
    const error = new PreviewAutomationTargetUnavailableError({
      requestId: "request-1",
      operation: "click",
      environmentId,
      threadId,
      tabId,
      bridgeAvailable: false,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-1",
        operation: "click",
        environmentId,
        threadId,
        tabId,
      }),
    ).toEqual({
      _tag: "PreviewAutomationTabNotFoundError",
      message:
        "Preview automation target for click request request-1 is unavailable on environment environment-1 thread thread-1 (tab tab-1, bridge unavailable).",
      detail: {
        requestId: "request-1",
        operation: "click",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
        bridgeAvailable: false,
      },
    });
  });

  it("reports a missing recording even when no preview tab remains", () => {
    const error = new PreviewAutomationRecordingNotActiveError({
      requestId: "request-recording-stop",
      environmentId,
      threadId,
      tabId: null,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-recording-stop",
        operation: "recordingStop",
        environmentId,
        threadId,
        tabId: null,
      }),
    ).toMatchObject({
      _tag: "PreviewAutomationExecutionError",
      detail: { tabId: null },
    });
  });

  it("preserves viewport render timeouts as timeout responses", () => {
    const error = new PreviewAutomationViewportTimeoutError({
      requestId: "request-resize",
      environmentId,
      threadId,
      tabId,
      timeoutMs: 2_500,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-resize",
        operation: "resize",
        environmentId,
        threadId,
        tabId,
      }),
    ).toMatchObject({
      _tag: "PreviewAutomationTimeoutError",
      detail: { tabId: "tab-1", timeoutMs: 2_500 },
    });
  });

  it("maps desktop non-editable targets to the public typed response", () => {
    expect(
      serializePreviewAutomationError(
        {
          _tag: "PreviewAutomationTargetNotEditableError",
          tabId: "tab-1",
          selectorKind: "selector",
          selectorLength: 6,
        },
        {
          requestId: "request-type",
          operation: "type",
          environmentId,
          threadId,
          tabId,
        },
      ),
    ).toEqual({
      _tag: "PreviewAutomationTargetNotEditableError",
      message:
        "Preview automation type request request-type requires an editable target in tab tab-1.",
      detail: {
        requestId: "request-type",
        operation: "type",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
        selectorKind: "selector",
        selectorLength: 6,
      },
    });
  });

  it("correlates unexpected failures without exposing cause details", () => {
    const cause = new Error("private bridge token: preview-secret");
    const context = {
      requestId: "request-2",
      operation: "snapshot" as const,
      environmentId,
      threadId,
      tabId,
    };
    const response = serializePreviewAutomationError(cause, context);

    expect(response).toEqual({
      _tag: "PreviewAutomationExecutionError",
      message:
        "Preview automation snapshot request request-2 failed on environment environment-1 thread thread-1 (tab tab-1).",
      detail: {
        requestId: "request-2",
        operation: "snapshot",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
      },
    });
    expect(JSON.stringify(response)).not.toContain("preview-secret");
  });

  it.each(["UnknownVizError", "AbortError"])(
    "preserves a filtered %s snapshot failure from Electron",
    (nativeName) => {
      const cause = new PreviewAutomationDesktopFailureError({
        nativeName,
        safeMessage: "surface capture was aborted",
      });
      const response = serializePreviewAutomationError(cause, {
        requestId: "request-native-error",
        operation: "snapshot",
        environmentId,
        threadId,
        tabId,
      });

      expect(response).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        detail: {
          cause: { name: nativeName, message: "surface capture was aborted" },
        },
      });
    },
  );

  it("replaces native error text containing a URL", () => {
    const cause = new Error("capture failed at https://preview.example/secret");
    cause.name = "UnknownVizError";
    const response = serializePreviewAutomationError(cause, {
      requestId: "request-native-url",
      operation: "snapshot",
      environmentId,
      threadId,
      tabId,
    });

    expect(response).toMatchObject({
      detail: {
        cause: { name: "UnknownVizError", message: "Preview capture failed." },
      },
    });
    expect(JSON.stringify(response)).not.toContain("preview.example");
  });

  it("preserves the owned timeout stage from a flattened IPC error", () => {
    const response = serializePreviewAutomationError(
      new Error(
        "Error invoking remote method: Preview snapshot capture timed out during capture-page after 2500ms in tab tab-1",
      ),
      {
        requestId: "request-capture-timeout",
        operation: "snapshot",
        environmentId,
        threadId,
        tabId,
      },
    );

    expect(response).toMatchObject({
      detail: {
        cause: {
          name: "PreviewAutomationTimeoutError",
          stage: "capture-page",
        },
      },
    });
  });

  it("bounds timeout tags and stages from raw failures", () => {
    const context = {
      requestId: "request-unbounded-timeout",
      operation: "snapshot" as const,
      environmentId,
      threadId,
      tabId,
    };
    const boundedTag = serializePreviewAutomationError(
      {
        _tag: "PreviewAutomationCaptureTimeoutError",
        message: "capture timed out",
        stage: "s".repeat(65),
      },
      context,
    );
    const unboundedTag = serializePreviewAutomationError(
      {
        _tag: `${"A".repeat(65)}TimeoutError`,
        message: "capture timed out",
        stage: "capture-page",
      },
      context,
    );

    const message =
      "Preview automation snapshot request request-unbounded-timeout failed on environment environment-1 thread thread-1 (tab tab-1).";
    expect(boundedTag).toEqual({
      _tag: "PreviewAutomationExecutionError",
      message,
      detail: {
        requestId: "request-unbounded-timeout",
        operation: "snapshot",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
        cause: {
          name: "PreviewAutomationCaptureTimeoutError",
          message: "Preview automation timed out.",
        },
      },
    });
    expect(unboundedTag).toEqual({
      _tag: "PreviewAutomationExecutionError",
      message,
      detail: {
        requestId: "request-unbounded-timeout",
        operation: "snapshot",
        environmentId: "environment-1",
        threadId: "thread-1",
        tabId: "tab-1",
      },
    });
  });

  it("responds with the host execution deadline before a stuck handler settles", async () => {
    vi.useFakeTimers();
    try {
      const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
        AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
      );
      const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
      const state = consumerState(() => new Promise(() => {}));
      const consumerAtom = createPreviewAutomationRequestConsumerAtom({
        requestsAtom,
        clientId,
        connectionAtom: state.connectionAtom,
        environmentId,
        requestHandlerAtom: state.requestHandlerAtom,
        respond,
        label: "test:preview-automation-host-deadline",
      });
      const registry = AtomRegistry.make();
      registry.mount(consumerAtom);
      registry.set(
        requestsAtom,
        AsyncResult.success(requestEvent("request-host-deadline", { timeoutMs: 250 })),
      );

      await vi.advanceTimersByTimeAsync(250);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "request-host-deadline",
          ok: false,
          error: expect.objectContaining({
            _tag: "PreviewAutomationTimeoutError",
            detail: expect.objectContaining({ stage: "host-execution", timeoutMs: 250 }),
          }),
        }),
      );
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes unexpected handler failures at the response boundary", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
      AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
    );
    const responses: PreviewAutomationResponse[] = [];
    const state = consumerState(async () => {
      throw new Error("desktop IPC secret: do-not-return");
    });
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      clientId,
      connectionAtom: state.connectionAtom,
      environmentId,
      requestHandlerAtom: state.requestHandlerAtom,
      respond: async (response) => {
        responses.push(response);
      },
      label: "test:preview-automation-failure-boundary",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(
      requestsAtom,
      AsyncResult.success(
        requestEvent("request-failed", {
          operation: "click",
          tabId,
        }),
      ),
    );

    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toEqual({
      clientId,
      connectionId,
      requestId: "request-failed",
      ok: false,
      error: {
        _tag: "PreviewAutomationExecutionError",
        message:
          "Preview automation click request request-failed failed on environment environment-1 thread thread-1 (tab tab-1).",
        detail: {
          requestId: "request-failed",
          operation: "click",
          environmentId: "environment-1",
          threadId: "thread-1",
          tabId: "tab-1",
        },
      },
    });
    expect(JSON.stringify(responses[0])).not.toContain("do-not-return");
    registry.dispose();
  });
});
