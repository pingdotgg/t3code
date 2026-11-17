import {
  EnvironmentId,
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  phase: "connected",
  listener: () => {},
  threadListener: () => {},
  stoppedRun: "",
  runCommand:
    vi.fn<(registry: unknown, command: string, args: { input: unknown }) => Promise<unknown>>(),
  connect: vi.fn<(input: unknown) => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  execute:
    vi.fn<
      (tab: string, connectionId: string, request: PreviewAutomationRequest) => Promise<unknown>
    >(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.runCommand }));
vi.mock("./atomRegistry", () => ({
  appAtomRegistry: {
    refresh: vi.fn(),
    get: (atom: string) =>
      atom === "thread"
        ? {
            data: Option.some({
              runs: mocks.stoppedRun ? [{ id: mocks.stoppedRun, status: "interrupted" }] : [],
            }),
          }
        : AsyncResult.success({ phase: mocks.phase }),
    subscribe: (_atom: unknown, listener: () => void) => {
      if (_atom === "thread") mocks.threadListener = listener;
      else mocks.listener = listener;
      return () => {};
    },
  },
}));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { stateAtom: () => "connection" } }));
vi.mock("~/state/threads", () => ({ environmentThreadDetails: { stateAtom: () => "thread" } }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    list: () => "list",
    desktopRegister: "register",
    desktopRequests: "requests",
    desktopRespond: "respond",
    resize: "resize",
    adjust: "adjust",
  },
}));
vi.mock("~/previewStateStore", () => ({
  updatePreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: () => ({
    sessions: {
      tab: { tabId: "tab", threadId: "thread", runtime: "desktop", navStatus: { _tag: "Idle" } },
    },
  }),
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    connectTabHost: mocks.connect,
    disconnectTabHost: mocks.disconnect,
    executeTabRequest: mocks.execute,
  },
}));
import { hostDesktopTab } from "./desktopTabRelay";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("reads status during an action and re-registers the same tab without forwarding a retired reply", async () => {
  const streams = new Map<
    string,
    { onEvent: (event: PreviewAutomationStreamEvent) => Promise<void>; signal: AbortSignal }
  >();
  const responses: unknown[] = [];
  let registration = 0;
  let attached = deferred<void>();
  let responded = deferred<void>();
  const navigation = deferred<unknown>();
  mocks.connect.mockImplementation(async () => {
    attached.resolve();
  });
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.runCommand.mockImplementation(async (_registry, command, { input }) => {
    if (command === "register")
      return AsyncResult.success({ connectionId: `connection-${++registration}` });
    if (command === "respond") {
      responses.push(input);
      responded.resolve();
      return AsyncResult.success(undefined);
    }
    const stream = input as {
      connectionId: string;
      onEvent: (event: PreviewAutomationStreamEvent) => Promise<void>;
      signal: AbortSignal;
    };
    streams.set(stream.connectionId, stream);
    return new Promise<void>((resolve) =>
      stream.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  mocks.execute.mockImplementation(async (_tab, connectionId, request) => {
    if (request.operation === "navigate") await navigation.promise;
    return {
      clientId: "desktop",
      connectionId,
      requestId: request.requestId,
      ok: true,
      result: {},
    };
  });
  const stop = hostDesktopTab(
    { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread") },
    "tab",
    "same-guest",
  );
  const event = (
    connectionId: string,
    operation: PreviewAutomationRequest["operation"],
  ): PreviewAutomationStreamEvent => ({
    type: "request",
    connectionId,
    request: {
      requestId: operation,
      tabId: "tab",
      threadId: ThreadId.make("thread"),
      operation,
      input: {},
      timeoutMs: 1000,
    },
  });
  try {
    await attached.promise;
    await Promise.resolve();
    await streams.get("connection-1")!.onEvent(event("connection-1", "navigate"));
    await streams.get("connection-1")!.onEvent(event("connection-1", "status"));
    await responded.promise;
    expect(responses).toMatchObject([{ connectionId: "connection-1", requestId: "status" }]);
    mocks.phase = "disconnected";
    mocks.listener();
    attached = deferred<void>();
    mocks.phase = "connected";
    mocks.listener();
    await attached.promise;
    await Promise.resolve();
    expect(streams.get("connection-1")!.signal.aborted).toBe(true);
    expect(mocks.connect.mock.calls[1]?.[0]).toMatchObject({
      runtimeTabId: "same-guest",
      connectionId: "connection-2",
    });
    navigation.resolve(undefined);
    responded = deferred<void>();
    await streams.get("connection-2")!.onEvent(event("connection-2", "snapshot"));
    await responded.promise;
    expect(responses).toMatchObject([
      { connectionId: "connection-1", requestId: "status" },
      { connectionId: "connection-2", requestId: "snapshot" },
    ]);
    expect(responses).toHaveLength(2);
  } finally {
    stop();
  }
});

it("retries a registration that overlaps a disconnect without another user action", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  mocks.phase = "connected";
  mocks.connect.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.runCommand.mockImplementation(async (_registry, command, { input }) => {
    if (command === "register") {
      attempts++;
      return attempts === 1
        ? AsyncResult.initial()
        : AsyncResult.success({ connectionId: "recovered" });
    }
    const stream = input as { signal: AbortSignal };
    return new Promise<void>((resolve) =>
      stream.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const stop = hostDesktopTab(
    { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread") },
    "tab",
    "same-guest",
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(2);
    expect(mocks.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeTabId: "same-guest", connectionId: "recovered" }),
    );
  } finally {
    stop();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("publishes viewport and appearance choices and rehosts the same guest when the thread stops", async () => {
  mocks.phase = "connected";
  mocks.stoppedRun = "";
  let registration = 0;
  let attached = deferred<void>();
  let responded = deferred<void>();
  let onEvent!: (event: PreviewAutomationStreamEvent) => Promise<void>;
  const commands: string[] = [];
  const aborted: AbortSignal[] = [];
  mocks.connect.mockImplementation(async () => {
    attached.resolve();
  });
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.runCommand.mockImplementation(async (_registry, command, { input }) => {
    commands.push(command);
    if (command === "register")
      return AsyncResult.success({ connectionId: `render-${++registration}` });
    if (command === "respond") {
      responded.resolve();
      return AsyncResult.success(undefined);
    }
    if (command === "resize" || command === "adjust") return AsyncResult.success({ tabId: "tab" });
    const stream = input as { signal: AbortSignal; onEvent: typeof onEvent };
    onEvent = stream.onEvent;
    aborted.push(stream.signal);
    return new Promise<void>((resolve) =>
      stream.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  mocks.execute.mockImplementation(async (_tab, connectionId, request) => ({
    clientId: "desktop",
    connectionId,
    requestId: request.requestId,
    ok: true,
    result:
      request.operation === "resize"
        ? {
            tabId: "tab",
            setting: { _tag: "freeform", width: 500, height: 700 },
            viewport: { width: 500, height: 700 },
          }
        : { tabId: "tab", colorScheme: "dark" },
  }));
  const stop = hostDesktopTab(
    { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread") },
    "tab",
    "same-guest",
  );
  try {
    await attached.promise;
    await Promise.resolve();
    for (const operation of ["resize", "setColorScheme"] as const) {
      responded = deferred<void>();
      await onEvent({
        type: "request",
        connectionId: "render-1",
        request: {
          requestId: operation,
          operation,
          tabId: "tab",
          threadId: ThreadId.make("thread"),
          input: {},
          timeoutMs: 1000,
        },
      });
      await responded.promise;
    }
    expect(commands.filter((command) => ["resize", "adjust", "respond"].includes(command))).toEqual(
      ["resize", "respond", "adjust", "respond"],
    );
    mocks.threadListener();
    await Promise.resolve();
    expect(registration).toBe(1);
    attached = deferred<void>();
    mocks.stoppedRun = "stopped-run";
    mocks.threadListener();
    await attached.promise;
    expect(aborted[0]?.aborted).toBe(true);
    expect(registration).toBe(2);
    expect(mocks.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeTabId: "same-guest", connectionId: "render-2" }),
    );
  } finally {
    stop();
    mocks.stoppedRun = "";
  }
});

it("re-registers after a timeout eviction completes the host stream while the environment stays connected", async () => {
  vi.useFakeTimers();
  mocks.phase = "connected";
  mocks.stoppedRun = "";
  let registration = 0;
  const evicted = deferred<unknown>();
  const streams: AbortSignal[] = [];
  mocks.connect.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.runCommand.mockImplementation(async (_registry, command, { input }) => {
    if (command === "register")
      return AsyncResult.success({ connectionId: `timeout-${++registration}` });
    const { signal } = input as { signal: AbortSignal };
    streams.push(signal);
    if (streams.length === 1) return evicted.promise;
    return new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const stop = hostDesktopTab(
    { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread") },
    "tab",
    "same-guest",
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(registration).toBe(1);
    // The broker ends only this stream; the environment socket remains healthy.
    evicted.resolve(AsyncResult.success(undefined));
    await vi.advanceTimersByTimeAsync(1000);
    expect(registration).toBe(2);
    expect(streams[0]?.aborted).toBe(true);
    expect(mocks.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeTabId: "same-guest", connectionId: "timeout-2" }),
    );
  } finally {
    stop();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});
