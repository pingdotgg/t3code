import {
  CommandId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn<(...args: Array<unknown>) => Promise<unknown>>();
const channelListeners = new Map<string, Set<(data: unknown) => void>>();
const subscribeMock = vi.fn<(channel: string, listener: (data: unknown) => void) => () => void>(
  (channel, listener) => {
    const listeners = channelListeners.get(channel) ?? new Set<(data: unknown) => void>();
    listeners.add(listener);
    channelListeners.set(channel, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        channelListeners.delete(channel);
      }
    };
  },
);

vi.mock("./wsTransport", () => {
  return {
    WsTransport: class MockWsTransport {
      request = requestMock;
      subscribe = subscribeMock;
    },
  };
});

function emitPush(channel: string, data: unknown): void {
  const listeners = channelListeners.get(channel);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(data);
  }
}

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  subscribeMock.mockClear();
  channelListeners.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsNativeApi", () => {
  it("delivers and caches valid server.welcome payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    const payload = { cwd: "/tmp/workspace", projectName: "t3-code" };
    emitPush(WS_CHANNELS.serverWelcome, payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);

    const lateListener = vi.fn();
    onServerWelcome(lateListener);

    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(payload);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores invalid server.welcome payloads and keeps subscription active", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi, onServerWelcome } = await import("./wsNativeApi");

    createWsNativeApi();
    const listener = vi.fn();
    onServerWelcome(listener);

    emitPush(WS_CHANNELS.serverWelcome, { cwd: 42, projectName: "t3-code" });
    emitPush(WS_CHANNELS.serverWelcome, { cwd: "/tmp/workspace", projectName: "t3-code" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ cwd: "/tmp/workspace", projectName: "t3-code" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: { cwd: 42, projectName: "t3-code" },
      issue: expect.stringContaining("SchemaError"),
    });
  });

  it("forwards valid terminal and orchestration events", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitPush(WS_CHANNELS.terminalEvent, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "project",
      aggregateId: "project-1",
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: "project-1",
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModel: null,
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } as const;
    emitPush(ORCHESTRATION_WS_CHANNELS.domainEvent, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledTimes(1);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops malformed terminal and orchestration push payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    emitPush(WS_CHANNELS.terminalEvent, {
      threadId: "thread-1",
      terminalId: "",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    });
    emitPush(ORCHESTRATION_WS_CHANNELS.domainEvent, {
      sequence: -1,
      type: "project.created",
    });

    expect(onTerminalEvent).not.toHaveBeenCalled();
    expect(onDomainEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, "Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: {
        threadId: "thread-1",
        terminalId: "",
        createdAt: "2026-02-24T00:00:00.000Z",
        type: "output",
        data: "hello",
      },
      issue: expect.stringContaining("SchemaError"),
    });
    expect(warnSpy).toHaveBeenNthCalledWith(2, "Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw: {
        sequence: -1,
        type: "project.created",
      },
      issue: expect.stringContaining("SchemaError"),
    });
  });

  it("wraps orchestration dispatch commands in the command envelope", async () => {
    requestMock.mockResolvedValue(undefined);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModel: "gpt-5-codex",
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command,
    });
  });

  it("forwards full-thread diff requests to the orchestration websocket method", async () => {
    requestMock.mockResolvedValue({ diff: "patch" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toTurnCount: 1,
    });

    expect(requestMock).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });
});
