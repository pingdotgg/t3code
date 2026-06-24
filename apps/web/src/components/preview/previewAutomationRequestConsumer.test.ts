import {
  EnvironmentId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewTabId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";
import {
  createPreviewAutomationRequestConsumerAtom,
  serializePreviewAutomationError,
} from "./previewAutomationRequestConsumer";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const tabId = PreviewTabId.make("tab-1");

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

describe("previewAutomationRequestConsumer", () => {
  it("consumes every request emitted before React can render", async () => {
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationRequest, Error>>(
      AsyncResult.initial<PreviewAutomationRequest, Error>(false),
    );
    const handleRequest = vi.fn(async (value: PreviewAutomationRequest) => ({
      requestId: value.requestId,
    }));
    const responses: PreviewAutomationResponse[] = [];
    const respond = vi.fn(async (response: PreviewAutomationResponse) => {
      responses.push(response);
    });
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      environmentId,
      handleRequest,
      respond,
      label: "test:preview-automation-consumer",
    });
    const registry = AtomRegistry.make();
    registry.mount(consumerAtom);

    registry.set(requestsAtom, AsyncResult.success(request("request-1")));
    registry.set(requestsAtom, AsyncResult.success(request("request-2")));

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(handleRequest.mock.calls.map(([value]) => value.requestId)).toEqual([
      "request-1",
      "request-2",
    ]);
    expect(responses.map((response) => response.requestId)).toEqual(["request-1", "request-2"]);
    registry.dispose();
  });

  it("consumes a request that arrived immediately before the consumer mounted", async () => {
    const requestsAtom = Atom.make(
      AsyncResult.success<PreviewAutomationRequest, Error>(request("request-ready")),
    );
    const respond = vi.fn(async (_response: PreviewAutomationResponse) => undefined);
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      environmentId,
      handleRequest: async () => undefined,
      respond,
      label: "test:preview-automation-initial-request",
    });
    const registry = AtomRegistry.make();

    registry.mount(consumerAtom);

    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith({ requestId: "request-ready", ok: true });
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
    const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationRequest, Error>>(
      AsyncResult.initial<PreviewAutomationRequest, Error>(false),
    );
    const responses: PreviewAutomationResponse[] = [];
    const consumerAtom = createPreviewAutomationRequestConsumerAtom({
      requestsAtom,
      environmentId,
      handleRequest: async () => {
        throw new Error("desktop IPC secret: do-not-return");
      },
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
        request("request-failed", {
          operation: "click",
          tabId,
        }),
      ),
    );

    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toEqual({
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
