import type { PreviewAutomationRequest, PreviewAutomationResponse } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewAutomationRequestConsumerAtom,
  serializePreviewAutomationError,
} from "./previewAutomationRequestConsumer";

const request = (requestId: string): PreviewAutomationRequest => ({
  requestId,
  threadId: ThreadId.make("thread-1"),
  operation: "status",
  input: {},
  timeoutMs: 15_000,
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

  it("preserves typed automation errors in responses", () => {
    const error = new Error("No preview tab");
    error.name = "PreviewAutomationTabNotFoundError";

    expect(serializePreviewAutomationError(error)).toEqual({
      _tag: "PreviewAutomationTabNotFoundError",
      message: "No preview tab",
    });
  });

  it("serializes structured automation context without leaking causes", () => {
    const error = Object.assign(new Error("Preview target unavailable"), {
      name: "PreviewAutomationTargetUnavailableError",
      _tag: "PreviewAutomationTargetUnavailableError",
      responseTag: "PreviewAutomationTabNotFoundError",
      requestId: "request-1",
      threadId: "thread-1",
      cause: new Error("private bridge failure"),
    });

    expect(serializePreviewAutomationError(error)).toEqual({
      _tag: "PreviewAutomationTabNotFoundError",
      message: "Preview target unavailable",
      detail: {
        requestId: "request-1",
        threadId: "thread-1",
      },
    });
  });
});
