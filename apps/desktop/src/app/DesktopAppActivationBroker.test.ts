import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";

const request: DesktopAppActivationRequest = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
};

function threadRequest(requestId: string, threadId = "thread-1"): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-thread",
    platform: "linux",
    environmentId: EnvironmentId.make("primary"),
    threadId: ThreadId.make(threadId),
  };
}

function success(requestId: string) {
  return {
    version: 1 as const,
    requestId,
    ok: true as const,
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
  };
}

function threadSuccess(requestId: string, threadId: string) {
  return {
    version: 1 as const,
    requestId,
    ok: true as const,
    environmentId: EnvironmentId.make("primary"),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make(threadId),
  };
}

function threadFailure(requestId: string) {
  return {
    version: 1 as const,
    requestId,
    ok: false as const,
    code: "thread-not-found" as const,
    message: "The stale renderer could not find the thread.",
  };
}

function threadSuperseded(requestId: string) {
  return {
    version: 1 as const,
    requestId,
    ok: false as const,
    code: "request-superseded" as const,
    message: "The renderer request is no longer active.",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function captureRenderer() {
  const requests: DesktopAppActivationRequest[] = [];
  const send = vi.fn((rendererRequest: DesktopAppActivationRequest) => {
    requests.push(rendererRequest);
  });
  return { requests, send };
}

async function expectStaleCompletionIgnored(
  invalidation: "cancel" | "supersede",
  staleCompletion: "failure" | "different-target-success" | "same-target-success",
): Promise<void> {
  const activate = vi.fn();
  const dispatched: DesktopAppActivationRequest[] = [];
  const send = vi.fn((rendererRequest: DesktopAppActivationRequest) => {
    dispatched.push(rendererRequest);
  });
  const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
  broker.registerRenderer(send);

  const originalRequest = threadRequest("reused-client-id", "old-thread");
  const originalResponse = broker.request(originalRequest);
  const originalDispatch = dispatched[0]!;

  let supersedingResponse: Promise<Awaited<typeof originalResponse>> | undefined;
  if (invalidation === "cancel") {
    broker.cancel(originalRequest.requestId);
    await expect(originalResponse).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
  } else {
    supersedingResponse = broker.request(threadRequest("superseding-client-id", "middle-thread"));
    await expect(originalResponse).resolves.toMatchObject({
      ok: false,
      code: "request-superseded",
    });
  }

  const replacementRequest = threadRequest("reused-client-id", "replacement-thread");
  const replacementResponse = broker.request(replacementRequest);
  if (supersedingResponse !== undefined) {
    await expect(supersedingResponse).resolves.toMatchObject({
      ok: false,
      code: "request-superseded",
    });
  }
  const replacementDispatch = dispatched.at(-1)!;

  expect(originalDispatch.requestId).not.toBe(originalRequest.requestId);
  expect(replacementDispatch.requestId).not.toBe(originalDispatch.requestId);
  expect(broker.isRequestActive(originalDispatch.requestId)).toBe(false);
  expect(broker.isRequestActive(replacementDispatch.requestId)).toBe(true);
  expect(broker.isRequestActive(originalRequest.requestId)).toBe(false);
  expect(broker.isRequestActive(replacementRequest.requestId)).toBe(false);
  expect(originalRequest).toEqual(threadRequest("reused-client-id", "old-thread"));
  expect(replacementRequest).toEqual(threadRequest("reused-client-id", "replacement-thread"));

  const received: Awaited<typeof replacementResponse>[] = [];
  void replacementResponse.then((response) => received.push(response));
  broker.complete(threadFailure(originalRequest.requestId));
  await Promise.resolve();
  expect(received).toEqual([]);

  const staleResponse =
    staleCompletion === "failure"
      ? threadFailure(originalDispatch.requestId)
      : threadSuccess(
          originalDispatch.requestId,
          staleCompletion === "same-target-success" ? "replacement-thread" : "other-thread",
        );
  broker.complete(staleResponse);
  await Promise.resolve();

  expect(received).toEqual([]);
  expect(activate).not.toHaveBeenCalled();

  broker.complete(threadSuccess(replacementDispatch.requestId, "replacement-thread"));
  const response = await replacementResponse;
  expect(response).toMatchObject({
    ok: true,
    requestId: "reused-client-id",
    threadId: "replacement-thread",
  });
  expect(activate).toHaveBeenCalledOnce();
  broker.close();
}

describe("DesktopAppActivationBroker", () => {
  it("ignores stale failures and successes when a canceled or superseded client id is reused", async () => {
    for (const invalidation of ["cancel", "supersede"] as const) {
      for (const staleCompletion of [
        "failure",
        "different-target-success",
        "same-target-success",
      ] as const) {
        await expectStaleCompletionIgnored(invalidation, staleCompletion);
      }
    }
  });

  it("stops a delayed renderer task from navigating after a canceled client id is reused", async () => {
    const activate = vi.fn();
    const dispatched: DesktopAppActivationRequest[] = [];
    const send = vi.fn((rendererRequest: DesktopAppActivationRequest) => {
      dispatched.push(rendererRequest);
    });
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const oldThreadId = ThreadId.make("old-thread");
    const oldRequest = threadRequest("reused-client-id", oldThreadId);
    const oldResponse = broker.request(oldRequest);
    const oldDispatch = dispatched[0]!;
    const probeStarted = deferred();
    const releaseProbe = deferred();
    const navigated: string[] = [];
    const staleTask = (async () => {
      probeStarted.resolve();
      await releaseProbe.promise;
      if (!(await Promise.resolve(broker.isRequestActive(oldDispatch.requestId)))) {
        return threadSuperseded(oldDispatch.requestId);
      }
      navigated.push(oldThreadId);
      return threadSuccess(oldDispatch.requestId, oldThreadId);
    })();
    await probeStarted.promise;

    broker.cancel(oldRequest.requestId);
    await expect(oldResponse).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    const replacementResponse = broker.request(
      threadRequest("reused-client-id", "replacement-thread"),
    );
    const replacementDispatch = dispatched[1]!;

    expect(broker.isRequestActive(oldDispatch.requestId)).toBe(false);
    expect(broker.isRequestActive(replacementDispatch.requestId)).toBe(true);
    releaseProbe.resolve();

    const staleResponse = await staleTask;
    expect(staleResponse).toMatchObject({
      ok: false,
      code: "request-superseded",
      requestId: oldDispatch.requestId,
    });
    expect(navigated).toEqual([]);
    broker.complete(staleResponse);
    broker.complete(threadSuccess(replacementDispatch.requestId, "replacement-thread"));

    await expect(replacementResponse).resolves.toMatchObject({
      ok: true,
      requestId: "reused-client-id",
      threadId: "replacement-thread",
    });
    expect(navigated).toEqual([]);
    expect(activate).toHaveBeenCalledOnce();
    broker.close();
  });

  it("focuses immediately and waits for renderer readiness", async () => {
    const activate = vi.fn();
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });

    const response = broker.request(request);
    expect(activate).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    broker.registerRenderer(send);
    expect(dispatched[0]).toMatchObject({ ...request, requestId: expect.any(String) });
    expect(dispatched[0]?.requestId).not.toBe(request.requestId);
    broker.complete({
      version: 1,
      requestId: dispatched[0]!.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true, projectId: "project-1" });
    broker.close();
  });

  it("fails an in-flight request when the renderer goes away", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(vi.fn());

    const response = broker.request(request);
    broker.clearRenderer();

    await expect(response).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
    broker.close();
  });

  it("queues requests after unsubscribe until a new renderer registers", async () => {
    const previousSend = vi.fn();
    const { requests: dispatched, send: nextSend } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(previousSend);
    broker.clearRenderer();

    const response = broker.request(request);
    expect(previousSend).not.toHaveBeenCalled();
    expect(nextSend).not.toHaveBeenCalled();

    broker.registerRenderer(nextSend);
    expect(dispatched[0]).toMatchObject({ ...request, requestId: expect.any(String) });
    broker.complete({
      version: 1,
      requestId: dispatched[0]!.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true });
    broker.close();
  });

  it("removes a queued request when its CLI connection closes", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });

    const response = broker.request(request);
    broker.cancel(request.requestId);
    broker.registerRenderer(send);

    await expect(response).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(send).not.toHaveBeenCalled();
    broker.close();
  });

  it("never sends a canceled request that was queued behind another request", async () => {
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send);
    const secondRequest = { ...request, requestId: "request-2" };

    const firstResponse = broker.request(request);
    const secondResponse = broker.request(secondRequest);
    expect(send).toHaveBeenCalledTimes(1);
    expect(dispatched[0]).toMatchObject({ ...request, requestId: expect.any(String) });

    broker.cancel(secondRequest.requestId);
    broker.complete({
      version: 1,
      requestId: dispatched[0]!.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(firstResponse).resolves.toMatchObject({ ok: true });
    await expect(secondResponse).resolves.toMatchObject({ ok: false });
    expect(send).toHaveBeenCalledTimes(1);
    broker.close();
  });

  it("times out a request without polling", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
      const response = broker.request(request);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(response).resolves.toMatchObject({ ok: false, code: "request-timeout" });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supersedes a queued open-thread request without dispatching it", async () => {
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send);

    const workspace = broker.request(request);
    expect(send).toHaveBeenCalledTimes(1);
    const workspaceDispatch = dispatched[0]!;

    const stale = broker.request(threadRequest("thread-a"));
    expect(broker.isRequestActive("thread-a")).toBe(false);
    const fresh = broker.request(threadRequest("thread-b"));

    await expect(stale).resolves.toMatchObject({ ok: false, code: "request-superseded" });
    expect(send).toHaveBeenCalledTimes(1);

    broker.complete(success(workspaceDispatch.requestId));
    expect(send).toHaveBeenCalledTimes(2);
    expect(dispatched[1]).toMatchObject({
      ...threadRequest("thread-b"),
      requestId: expect.any(String),
    });

    broker.complete({
      version: 1,
      requestId: dispatched[1]!.requestId,
      ok: false,
      code: "thread-open-failed",
      message: "The test stopped the navigation.",
    });
    await expect(fresh).resolves.toMatchObject({ ok: false });
    await expect(workspace).resolves.toMatchObject({ ok: true });
    broker.close();
  });

  it("reports a queued request inactive until the renderer receives it", async () => {
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });

    const queued = broker.request(request);
    expect(broker.isRequestActive(request.requestId)).toBe(false);

    broker.registerRenderer(send);
    const dispatchRequestId = dispatched[0]!.requestId;
    expect(broker.isRequestActive(dispatchRequestId)).toBe(true);
    expect(broker.isRequestActive(request.requestId)).toBe(false);

    broker.complete(success(dispatchRequestId));
    expect(broker.isRequestActive(dispatchRequestId)).toBe(false);
    await queued;
    broker.close();
  });

  it("activates an open-thread once only after the renderer confirms the target", async () => {
    const activate = vi.fn();
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const response = broker.request(threadRequest("thread-1"));
    expect(activate).not.toHaveBeenCalled();
    const dispatchRequestId = dispatched[0]!.requestId;
    expect(dispatched[0]).toMatchObject({
      ...threadRequest("thread-1"),
      requestId: expect.any(String),
    });

    broker.complete({
      version: 1,
      requestId: dispatchRequestId,
      ok: true,
      environmentId: EnvironmentId.make("primary"),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true, threadId: "thread-1" });
    expect(activate).toHaveBeenCalledOnce();
    broker.close();
  });

  it("does not activate when the renderer reports the thread missing", async () => {
    const activate = vi.fn();
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const response = broker.request(threadRequest("thread-missing"));
    broker.complete({
      version: 1,
      requestId: dispatched[0]!.requestId,
      ok: false,
      code: "thread-not-found",
      message: "No such thread.",
    });

    await expect(response).resolves.toMatchObject({
      ok: false,
      code: "thread-not-found",
      requestId: "thread-missing",
    });
    expect(activate).not.toHaveBeenCalled();
    broker.close();
  });

  it("fails an open-thread immediately and never queues it without a renderer", async () => {
    const activate = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });

    const response = broker.request(threadRequest("no-window"));
    await expect(response).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(activate).not.toHaveBeenCalled();

    const send = vi.fn();
    broker.registerRenderer(send);
    expect(send).not.toHaveBeenCalled();
    broker.close();
  });

  it("rejects an open-thread with no renderer without superseding pending work", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const workspace = broker.request(request);
    const queued = broker.request(threadRequest("queued"));
    expect(activate).toHaveBeenCalledOnce();
    broker.clearRenderer();
    await expect(workspace).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    await expect(queued).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });

    const rejected = broker.request(threadRequest("late-with-no-window"));
    await expect(rejected).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });

    const nextSend = vi.fn();
    broker.registerRenderer(nextSend);
    expect(nextSend).not.toHaveBeenCalled();

    broker.complete({
      version: 1,
      requestId: "queued",
      ok: true,
      environmentId: EnvironmentId.make("primary"),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });
    expect(activate).toHaveBeenCalledOnce();
    broker.close();
  });

  it("fails an open-thread when the renderer throws instead of requeueing it", async () => {
    const activate = vi.fn();
    const throwingSend = vi.fn(() => {
      throw new Error("renderer send failed");
    });
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(throwingSend);

    const response = broker.request(threadRequest("thread-throws"));
    await expect(response).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(activate).not.toHaveBeenCalled();

    const nextSend = vi.fn();
    broker.registerRenderer(nextSend);
    expect(nextSend).not.toHaveBeenCalled();
    broker.close();
  });

  it("uses a new dispatch id when an open-workspace request is retried after renderer send fails", async () => {
    const failedDispatches: DesktopAppActivationRequest[] = [];
    const failingRenderer = vi.fn((rendererRequest: DesktopAppActivationRequest) => {
      failedDispatches.push(rendererRequest);
      throw new Error("renderer send failed");
    });
    const { requests: successfulDispatches, send: workingRenderer } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(failingRenderer);

    const response = broker.request(request);
    expect(failingRenderer).toHaveBeenCalledOnce();

    broker.registerRenderer(workingRenderer);
    expect(successfulDispatches).toHaveLength(1);
    expect(successfulDispatches[0]?.requestId).not.toBe(failedDispatches[0]?.requestId);
    broker.complete(success(successfulDispatches[0]!.requestId));

    await expect(response).resolves.toMatchObject({
      ok: true,
      requestId: request.requestId,
    });
    broker.close();
  });

  it("does not activate when a cancelled open-thread later completes", async () => {
    const activate = vi.fn();
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const response = broker.request(threadRequest("thread-1"));
    const dispatchRequestId = dispatched[0]!.requestId;
    broker.cancel("thread-1");
    await expect(response).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });

    broker.complete({
      version: 1,
      requestId: dispatchRequestId,
      ok: true,
      environmentId: EnvironmentId.make("primary"),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });
    expect(activate).not.toHaveBeenCalled();
    broker.close();
  });

  it("does not activate a superseded open-thread when a late success arrives", async () => {
    const activate = vi.fn();
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const stale = broker.request(threadRequest("thread-a"));
    const staleDispatch = dispatched[0]!;
    const fresh = broker.request(threadRequest("thread-b"));
    const freshDispatch = dispatched[1]!;
    await expect(stale).resolves.toMatchObject({ ok: false, code: "request-superseded" });
    expect(activate).not.toHaveBeenCalled();
    expect(broker.isRequestActive(staleDispatch.requestId)).toBe(false);
    expect(broker.isRequestActive(freshDispatch.requestId)).toBe(true);

    broker.complete({
      version: 1,
      requestId: staleDispatch.requestId,
      ok: true,
      environmentId: EnvironmentId.make("primary"),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });
    expect(activate).not.toHaveBeenCalled();

    broker.cancel("thread-b");
    await fresh;
    broker.close();
  });

  it("does not activate or report success when the renderer acks a different target", async () => {
    const activate = vi.fn();
    const { requests: dispatched, send } = captureRenderer();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const response = broker.request(threadRequest("thread-1"));
    broker.complete({
      version: 1,
      requestId: dispatched[0]!.requestId,
      ok: true,
      environmentId: EnvironmentId.make("other-environment"),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: false, code: "thread-open-failed" });
    expect(activate).not.toHaveBeenCalled();
    broker.close();
  });

  it("drops activity on cancel, timeout and close", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
      const { requests: dispatched, send } = captureRenderer();
      broker.registerRenderer(send);

      const timedOut = broker.request({ ...request, requestId: "timeout" });
      const timeoutDispatchId = dispatched[0]!.requestId;
      expect(broker.isRequestActive(timeoutDispatchId)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(broker.isRequestActive(timeoutDispatchId)).toBe(false);
      await timedOut;

      const canceled = broker.request({ ...request, requestId: "cancel" });
      const canceledDispatchId = dispatched[1]!.requestId;
      expect(broker.isRequestActive(canceledDispatchId)).toBe(true);
      broker.cancel("cancel");
      expect(broker.isRequestActive(canceledDispatchId)).toBe(false);
      await canceled;

      const closed = broker.request({ ...request, requestId: "close" });
      const closedDispatchId = dispatched[2]!.requestId;
      expect(broker.isRequestActive(closedDispatchId)).toBe(true);
      broker.close();
      expect(broker.isRequestActive(closedDispatchId)).toBe(false);
      await closed;
    } finally {
      vi.useRealTimers();
    }
  });
});
