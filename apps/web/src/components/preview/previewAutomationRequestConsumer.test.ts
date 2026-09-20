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
  PreviewAutomationBackgroundPresentationTimeoutError,
  PreviewAutomationHostDeadlineExceededError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationVisibilityTimeoutError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import {
  createPreviewAutomationRequestConsumerAtom,
  previewAutomationExecutionBudget,
  previewAutomationInputWithRemainingTimeout,
  previewAutomationRemainingBestEffortBudget,
  previewAutomationRemainingBudget,
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
  it("preserves the full execution budget for short requested timeouts", () => {
    expect(previewAutomationExecutionBudget(100, 250)).toBe(100);
    expect(previewAutomationExecutionBudget(500, 250)).toBe(500);
    expect(previewAutomationExecutionBudget(501, 250)).toBe(500);
    expect(previewAutomationExecutionBudget(750, 250)).toBe(500);
    expect(previewAutomationExecutionBudget(751, 250)).toBe(501);
    expect(previewAutomationExecutionBudget(1_000, 250)).toBe(750);
    expect(previewAutomationExecutionBudget(1_000)).toBe(750);
  });

  it("keeps execution budgets monotonic as requested timeouts increase", () => {
    const budgets = Array.from({ length: 1_001 }, (_, timeoutMs) =>
      previewAutomationExecutionBudget(timeoutMs, 250),
    );

    expect(budgets.every((budget, index) => index === 0 || budget >= budgets[index - 1]!)).toBe(
      true,
    );
  });

  it("reports an expired operation budget instead of clamping it to one millisecond", () => {
    expect(previewAutomationRemainingBudget(1_000, 15_000, 999)).toBe(1);
    expect(previewAutomationRemainingBudget(1_000, 15_000, 1_001)).toBe(-1);
  });

  it("clamps an expired best-effort operation budget to zero", () => {
    expect(previewAutomationRemainingBestEffortBudget(1_000, 15_000, 999)).toBe(1);
    expect(previewAutomationRemainingBestEffortBudget(1_000, 15_000, 1_001)).toBe(0);
  });

  it("clamps timeout-bearing desktop inputs to the remaining host budget", () => {
    const remainingOperationBudget = vi.fn((requestedTimeoutMs: number) =>
      Math.min(requestedTimeoutMs, 125),
    );

    expect(
      previewAutomationInputWithRemainingTimeout(
        { locator: "text=Continue", timeoutMs: 500 },
        15_000,
        remainingOperationBudget,
      ),
    ).toEqual({ locator: "text=Continue", timeoutMs: 125 });
    expect(
      previewAutomationInputWithRemainingTimeout({ text: "ready" }, 750, remainingOperationBudget),
    ).toEqual({ text: "ready", timeoutMs: 125 });
    expect(remainingOperationBudget.mock.calls).toEqual([[500], [750]]);
  });

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

  it("preserves browser visibility timeouts as timeout responses", () => {
    const error = new PreviewAutomationVisibilityTimeoutError({
      requestId: "request-open",
      environmentId,
      threadId,
      tabId,
      timeoutMs: 2_000,
      activeSurfaceKind: "inline-preview",
      activeSurfaceId: "mini-player:tab-1",
      inlinePreviewOpen: true,
      inlinePreviewTabId: "tab-1",
      rightPanelOpen: false,
      rightPanelSurfaceId: null,
      surfaceRegistered: true,
      presentationRectAvailable: false,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-open",
        operation: "open",
        environmentId,
        threadId,
        tabId,
      }),
    ).toMatchObject({
      _tag: "PreviewAutomationTimeoutError",
      detail: {
        tabId: "tab-1",
        timeoutMs: 2_000,
        activeSurfaceKind: "inline-preview",
        activeSurfaceId: "mini-player:tab-1",
        inlinePreviewOpen: true,
        inlinePreviewTabId: "tab-1",
        rightPanelOpen: false,
        rightPanelSurfaceId: null,
        surfaceRegistered: true,
        presentationRectAvailable: false,
      },
    });
  });

  it("preserves background presentation timeouts as timeout responses", () => {
    const error = new PreviewAutomationBackgroundPresentationTimeoutError({
      requestId: "request-background",
      environmentId,
      threadId,
      tabId,
      timeoutMs: 1_500,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-background",
        operation: "snapshot",
        environmentId,
        threadId,
        tabId,
      }),
    ).toMatchObject({
      _tag: "PreviewAutomationTimeoutError",
      detail: { tabId: "tab-1", timeoutMs: 1_500 },
    });
  });

  it("preserves host response deadline errors as timeout responses", () => {
    const error = new PreviewAutomationHostDeadlineExceededError({
      requestId: "request-snapshot",
      operation: "snapshot",
      environmentId,
      threadId,
      tabId,
      timeoutMs: 14_750,
    });

    expect(
      serializePreviewAutomationError(error, {
        requestId: "request-snapshot",
        operation: "snapshot",
        environmentId,
        threadId,
        tabId,
      }),
    ).toMatchObject({
      _tag: "PreviewAutomationTimeoutError",
      detail: { tabId: "tab-1", timeoutMs: 14_750 },
    });
  });

  it("responds before the broker deadline when the host operation stalls", async () => {
    vi.useFakeTimers();
    try {
      const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
        AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
      );
      const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
      const state = consumerState(() => new Promise(() => undefined));
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
        AsyncResult.success(
          requestEvent("request-stalled", {
            operation: "snapshot",
            tabId,
            timeoutMs: 1_000,
          }),
        ),
      );

      await vi.advanceTimersByTimeAsync(750);

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "request-stalled",
          ok: false,
          error: expect.objectContaining({
            _tag: "PreviewAutomationTimeoutError",
            detail: expect.objectContaining({ timeoutMs: 750 }),
          }),
        }),
      );
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not collapse a short host timeout to one millisecond", async () => {
    vi.useFakeTimers();
    try {
      const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
        AsyncResult.initial<PreviewAutomationStreamEvent, Error>(false),
      );
      const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
      const state = consumerState(() => new Promise(() => undefined));
      const consumerAtom = createPreviewAutomationRequestConsumerAtom({
        requestsAtom,
        clientId,
        connectionAtom: state.connectionAtom,
        environmentId,
        requestHandlerAtom: state.requestHandlerAtom,
        respond,
        label: "test:preview-automation-short-deadline",
      });
      const registry = AtomRegistry.make();
      registry.mount(consumerAtom);
      registry.set(
        requestsAtom,
        AsyncResult.success(
          requestEvent("request-short", {
            operation: "click",
            tabId,
            timeoutMs: 100,
          }),
        ),
      );

      await vi.advanceTimersByTimeAsync(99);
      expect(respond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "request-short",
          ok: false,
          error: expect.objectContaining({
            _tag: "PreviewAutomationTimeoutError",
            detail: expect.objectContaining({ timeoutMs: 100 }),
          }),
        }),
      );
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
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
