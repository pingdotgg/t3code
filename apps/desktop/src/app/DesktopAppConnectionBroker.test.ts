import { EnvironmentId, type DesktopAppConnectionRequest } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ConnectionRendererSender,
  DesktopAppConnectionBroker,
} from "./DesktopAppConnectionBroker.ts";

const environmentId = EnvironmentId.make("env-1");

function request(requestId: string): DesktopAppConnectionRequest {
  return { version: 1, requestId, type: "connection", operation: "shell", environmentId };
}

function renderer() {
  return {
    dispatch: vi.fn<ConnectionRendererSender["dispatch"]>(),
    cancel: vi.fn<ConnectionRendererSender["cancel"]>(),
  };
}

function broker(overrides: { requestTimeoutMs?: number; maxPending?: number } = {}) {
  return new DesktopAppConnectionBroker({
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1_000,
    maxPending: overrides.maxPending ?? 4,
  });
}

const okResult = { sequence: 1 } as const;

describe("DesktopAppConnectionBroker", () => {
  it("dispatches concurrently without waiting for earlier requests", () => {
    const send = renderer();
    const subject = broker();
    subject.registerRenderer(send);
    void subject.request(request("a"));
    void subject.request(request("b"));
    expect(send.dispatch).toHaveBeenCalledTimes(2);
    expect(send.dispatch.mock.calls[0]?.[0].dispatchId).not.toBe(
      send.dispatch.mock.calls[1]?.[0].dispatchId,
    );
    subject.close();
  });

  it("ignores a late completion for a reused request id after cancellation", async () => {
    const send = renderer();
    const subject = broker();
    subject.registerRenderer(send);

    const firstRequest = request("same");
    const first = subject.request(firstRequest);
    const firstDispatch = send.dispatch.mock.calls[0]![0];
    subject.cancel(firstRequest);
    await expect(first).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(send.cancel).toHaveBeenCalledWith(firstDispatch.dispatchId);

    const second = subject.request(request("same"));
    subject.complete({
      dispatchId: firstDispatch.dispatchId,
      response: { version: 1, requestId: "same", ok: true, result: okResult },
    });
    expect(subject.pendingCount).toBe(1);

    const secondDispatch = send.dispatch.mock.calls[1]![0];
    subject.complete({
      dispatchId: secondDispatch.dispatchId,
      response: { version: 1, requestId: "same", ok: true, result: { sequence: 2 } },
    });
    await expect(second).resolves.toMatchObject({ ok: true, result: { sequence: 2 } });
    subject.close();
  });

  it("only cancels the exact request that owns the pending id", async () => {
    const send = renderer();
    const subject = broker();
    subject.registerRenderer(send);
    const firstRequest = request("same");
    const first = subject.request(firstRequest);
    const duplicate = request("same");
    await expect(subject.request(duplicate)).resolves.toMatchObject({ code: "invalid-request" });

    subject.cancel(duplicate);
    expect(subject.pendingCount).toBe(1);
    expect(send.cancel).not.toHaveBeenCalled();

    const dispatch = send.dispatch.mock.calls[0]![0];
    subject.complete({
      dispatchId: dispatch.dispatchId,
      response: { version: 1, requestId: "same", ok: true, result: okResult },
    });
    await expect(first).resolves.toMatchObject({ ok: true });

    // A socket that already got its answer cannot cancel a later reuse of its id.
    const reused = subject.request(request("same"));
    subject.cancel(firstRequest);
    expect(subject.pendingCount).toBe(1);
    subject.close();
    await expect(reused).resolves.toMatchObject({ code: "renderer-unavailable" });
  });

  it("keeps an in-flight dispatch valid when the renderer reports ready twice", async () => {
    const send = renderer();
    const subject = broker();
    subject.registerRenderer(send);
    const response = subject.request(request("a"));
    const dispatch = send.dispatch.mock.calls[0]![0];

    subject.registerRenderer(send);
    expect(send.dispatch).toHaveBeenCalledTimes(1);
    subject.complete({
      dispatchId: dispatch.dispatchId,
      response: { version: 1, requestId: "a", ok: true, result: okResult },
    });
    await expect(response).resolves.toMatchObject({ ok: true });
    subject.close();
  });

  it("tells the renderer to stop when the request times out", async () => {
    vi.useFakeTimers();
    try {
      const send = renderer();
      const subject = broker({ requestTimeoutMs: 50 });
      subject.registerRenderer(send);
      const response = subject.request(request("slow"));
      const dispatch = send.dispatch.mock.calls[0]![0];
      vi.advanceTimersByTime(60);
      await expect(response).resolves.toMatchObject({ ok: false, code: "request-timeout" });
      expect(send.cancel).toHaveBeenCalledWith(dispatch.dispatchId);
      subject.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues until a renderer registers and fails dispatched work when it leaves", async () => {
    const send = renderer();
    const subject = broker();
    const queued = subject.request(request("queued"));
    expect(subject.pendingCount).toBe(1);

    subject.registerRenderer(send);
    expect(send.dispatch).toHaveBeenCalledTimes(1);
    subject.clearRenderer();
    await expect(queued).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    subject.close();
  });

  it("bounds in-flight requests and rejects duplicate ids", async () => {
    const subject = broker({ maxPending: 1 });
    void subject.request(request("a"));
    await expect(subject.request(request("a"))).resolves.toMatchObject({
      code: "invalid-request",
    });
    await expect(subject.request(request("b"))).resolves.toMatchObject({
      code: "too-many-requests",
    });
    subject.close();
  });
});
