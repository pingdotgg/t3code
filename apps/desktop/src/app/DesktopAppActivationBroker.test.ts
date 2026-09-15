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

function threadRequest(requestId: string): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-thread",
    platform: "linux",
    environmentId: EnvironmentId.make("primary"),
    threadId: ThreadId.make("thread-1"),
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

describe("DesktopAppActivationBroker", () => {
  it("focuses immediately and waits for renderer readiness", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });

    const response = broker.request(request);
    expect(activate).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    broker.registerRenderer(send);
    expect(send).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
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
    const nextSend = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(previousSend);
    broker.clearRenderer();

    const response = broker.request(request);
    expect(previousSend).not.toHaveBeenCalled();
    expect(nextSend).not.toHaveBeenCalled();

    broker.registerRenderer(nextSend);
    expect(nextSend).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
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
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send);
    const secondRequest = { ...request, requestId: "request-2" };

    const firstResponse = broker.request(request);
    const secondResponse = broker.request(secondRequest);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(request);

    broker.cancel(secondRequest.requestId);
    broker.complete({
      version: 1,
      requestId: request.requestId,
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
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send);

    const workspace = broker.request(request);
    expect(send).toHaveBeenCalledTimes(1);

    const stale = broker.request(threadRequest("thread-a"));
    expect(broker.isRequestActive("thread-a")).toBe(false);
    const fresh = broker.request(threadRequest("thread-b"));

    await expect(stale).resolves.toMatchObject({ ok: false, code: "request-superseded" });
    expect(send).toHaveBeenCalledTimes(1);

    broker.complete(success(request.requestId));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(threadRequest("thread-b"));

    broker.complete({
      version: 1,
      requestId: "thread-b",
      ok: false,
      code: "thread-open-failed",
      message: "The test stopped the navigation.",
    });
    await expect(fresh).resolves.toMatchObject({ ok: false });
    await expect(workspace).resolves.toMatchObject({ ok: true });
    broker.close();
  });

  it("reports a queued request inactive until the renderer receives it", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });

    const queued = broker.request(request);
    expect(broker.isRequestActive(request.requestId)).toBe(false);

    broker.registerRenderer(send);
    expect(broker.isRequestActive(request.requestId)).toBe(true);

    broker.complete(success(request.requestId));
    expect(broker.isRequestActive(request.requestId)).toBe(false);
    await queued;
    broker.close();
  });

  it("activates an open-thread once only after the renderer confirms the target", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const response = broker.request(threadRequest("thread-1"));
    expect(activate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(threadRequest("thread-1"));

    broker.complete({
      version: 1,
      requestId: "thread-1",
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
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(vi.fn());

    const response = broker.request(threadRequest("thread-missing"));
    broker.complete({
      version: 1,
      requestId: "thread-missing",
      ok: false,
      code: "thread-not-found",
      message: "No such thread.",
    });

    await expect(response).resolves.toMatchObject({ ok: false, code: "thread-not-found" });
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

  it("does not activate when a cancelled open-thread later completes", async () => {
    const activate = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(vi.fn());

    const response = broker.request(threadRequest("thread-1"));
    broker.cancel("thread-1");
    await expect(response).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });

    broker.complete({
      version: 1,
      requestId: "thread-1",
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
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);

    const stale = broker.request(threadRequest("thread-a"));
    const fresh = broker.request(threadRequest("thread-b"));
    await expect(stale).resolves.toMatchObject({ ok: false, code: "request-superseded" });
    expect(activate).not.toHaveBeenCalled();

    broker.complete({
      version: 1,
      requestId: "thread-a",
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
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(vi.fn());

    const response = broker.request(threadRequest("thread-1"));
    broker.complete({
      version: 1,
      requestId: "thread-1",
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
      broker.registerRenderer(vi.fn());

      const timedOut = broker.request({ ...request, requestId: "timeout" });
      expect(broker.isRequestActive("timeout")).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(broker.isRequestActive("timeout")).toBe(false);
      await timedOut;

      const canceled = broker.request({ ...request, requestId: "cancel" });
      expect(broker.isRequestActive("cancel")).toBe(true);
      broker.cancel("cancel");
      expect(broker.isRequestActive("cancel")).toBe(false);
      await canceled;

      const closed = broker.request({ ...request, requestId: "close" });
      expect(broker.isRequestActive("close")).toBe(true);
      broker.close();
      expect(broker.isRequestActive("close")).toBe(false);
      await closed;
    } finally {
      vi.useRealTimers();
    }
  });
});
