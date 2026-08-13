import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { AetherApiTransportError } from "./restClient.ts";
import type { AetherRestClient, AetherRestError } from "./restClient.ts";
import type { AetherTask, AetherWorkspaceConnectOutcome } from "./restSchemas.ts";
import {
  connectForTransport,
  resolveTaskWorkspace,
  runAetherAgentStream,
  aetherWorkspaceSocketUrl,
  type AetherAgentConnection,
  type AetherAgentStreamOptions,
  type AetherWebSocketLike,
} from "./workspaceSocket.ts";
import type { AetherAgentEvent, AetherPortsMessage } from "./wireEvents.ts";
import { taskProcessing, wsAssistantDelta, wsUnknownKindFrame } from "./eventMapper.fixtures.ts";

const taskQueued: AetherTask = {
  ...taskProcessing,
  status: "queued",
  run_context: null,
};

const taskParked: AetherTask = {
  ...taskProcessing,
  status: "awaiting_input",
  run_context: null,
  awaiting_input: { kind: "message" },
};

const taskErrored: AetherTask = {
  ...taskProcessing,
  status: "errored",
  run_context: null,
  error: "provisioning failed",
  completed_at: "2026-08-08T10:05:00Z",
};

const taskUnknown: AetherTask = {
  ...taskProcessing,
  status: "unknown-status",
  rawStatus: "hibernating",
};

const ZERO_TIMING = {
  pollInitialMs: 0,
  pollMaxMs: 0,
  reconnectInitialMs: 0,
  reconnectMaxMs: 0,
  connectDefaultRetryMs: 0,
} as const;

/** getTask fake returning scripted answers in order (last one repeats). */
function scriptedGetTask(answers: ReadonlyArray<AetherTask>): {
  readonly getTask: AetherRestClient["getTask"];
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    getTask: () => {
      const answer = answers[Math.min(calls, answers.length - 1)]!;
      calls++;
      return Effect.succeed(answer);
    },
    calls: () => calls,
  };
}

const runningOutcome: AetherWorkspaceConnectOutcome = {
  state: "running",
  transport: { websocket_path: "/workspaces/ws-1/ws", preview_token: "t".repeat(32) },
};

function scriptedConnect(answers: ReadonlyArray<AetherWorkspaceConnectOutcome | AetherRestError>): {
  readonly connectWorkspace: AetherRestClient["connectWorkspace"];
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    connectWorkspace: () => {
      const answer = answers[Math.min(calls, answers.length - 1)]!;
      calls++;
      return "state" in answer ? Effect.succeed(answer) : Effect.fail(answer);
    },
    calls: () => calls,
  };
}

describe("resolveTaskWorkspace", () => {
  it.effect("proceeds on processing with the run_context workspace id", () =>
    Effect.gen(function* () {
      const fake = scriptedGetTask([taskProcessing]);
      const resolution = yield* resolveTaskWorkspace({
        getTask: fake.getTask,
        taskId: "task-1",
        timing: ZERO_TIMING,
      });
      expect(resolution).toMatchObject({ _tag: "workspace", workspaceId: "ws-1" });
      expect(fake.calls()).toBe(1);
    }),
  );

  it.effect("backs off through queued until the dispatcher flips to processing", () =>
    Effect.gen(function* () {
      const fake = scriptedGetTask([taskQueued, taskQueued, taskProcessing]);
      const resolution = yield* resolveTaskWorkspace({
        getTask: fake.getTask,
        taskId: "task-1",
        timing: ZERO_TIMING,
      });
      expect(resolution._tag).toBe("workspace");
      expect(fake.calls()).toBe(3);
    }),
  );

  it.effect("treats null-context awaiting_input as TERMINAL: parked, zero further polls", () =>
    Effect.gen(function* () {
      // The parked state is STABLE (all queued messages cancelled before
      // workspace assignment); backing off on it would poll forever.
      const fake = scriptedGetTask([taskParked]);
      const resolution = yield* resolveTaskWorkspace({
        getTask: fake.getTask,
        taskId: "task-1",
        timing: ZERO_TIMING,
      });
      expect(resolution._tag).toBe("parked");
      expect(fake.calls()).toBe(1);
    }),
  );

  it.effect("fails loudly with the task's error payload when errored before assignment", () =>
    Effect.gen(function* () {
      const fake = scriptedGetTask([taskErrored]);
      const error = yield* Effect.flip(
        resolveTaskWorkspace({ getTask: fake.getTask, taskId: "task-1", timing: ZERO_TIMING }),
      );
      expect(error._tag).toBe("AetherTaskErroredError");
      if (error._tag === "AetherTaskErroredError") {
        expect(error.error).toBe("provisioning failed");
        expect(error.completedAt).toBe("2026-08-08T10:05:00Z");
      }
      // No infinite poll: exactly one read.
      expect(fake.calls()).toBe(1);
    }),
  );

  it.effect("fails loudly on the unknown-status carrier, never treating it as pending", () =>
    Effect.gen(function* () {
      const fake = scriptedGetTask([taskUnknown]);
      const error = yield* Effect.flip(
        resolveTaskWorkspace({ getTask: fake.getTask, taskId: "task-1", timing: ZERO_TIMING }),
      );
      expect(error._tag).toBe("AetherTaskUnknownStatusError");
      expect(fake.calls()).toBe(1);
    }),
  );
});

describe("connectForTransport", () => {
  it.effect("loops through connecting and the transitional 409 to running", () =>
    Effect.gen(function* () {
      const fake = scriptedConnect([
        { state: "connecting", retry_after_ms: 0 },
        {
          state: "conflict",
          conflict: { kind: "transitional", error: "suspending", retry_after_ms: 0 },
        },
        runningOutcome,
      ]);
      const resolution = yield* connectForTransport({
        connectWorkspace: fake.connectWorkspace,
        workspaceId: "ws-1",
        start: false,
        timing: ZERO_TIMING,
      });
      expect(resolution).toMatchObject({ _tag: "transport", websocketPath: "/workspaces/ws-1/ws" });
      expect(fake.calls()).toBe(3);
    }),
  );

  it.effect("treats the startable 409 as unavailable — passive attach never boots a VM", () =>
    Effect.gen(function* () {
      const fake = scriptedConnect([
        { state: "conflict", conflict: { kind: "startable", error: "workspace is idle" } },
      ]);
      const resolution = yield* connectForTransport({
        connectWorkspace: fake.connectWorkspace,
        workspaceId: "ws-1",
        start: false,
        timing: ZERO_TIMING,
      });
      expect(resolution).toMatchObject({ _tag: "unavailable" });
      expect(fake.calls()).toBe(1);
    }),
  );

  it.effect("treats not_connectable as unavailable, naming the display state", () =>
    Effect.gen(function* () {
      const fake = scriptedConnect([
        {
          state: "conflict",
          conflict: {
            kind: "not_connectable",
            error: "workspace deleted",
            display_state: "deleted",
          },
        },
      ]);
      const resolution = yield* connectForTransport({
        connectWorkspace: fake.connectWorkspace,
        workspaceId: "ws-1",
        start: false,
        timing: ZERO_TIMING,
      });
      expect(resolution).toMatchObject({ _tag: "unavailable" });
      if (resolution._tag === "unavailable") {
        expect(resolution.reason).toContain("deleted");
      }
    }),
  );

  it.effect("fails loudly after the connecting retry budget", () =>
    Effect.gen(function* () {
      const fake = scriptedConnect([{ state: "connecting", retry_after_ms: 0 }]);
      const error = yield* Effect.flip(
        connectForTransport({
          connectWorkspace: fake.connectWorkspace,
          workspaceId: "ws-1",
          start: false,
          timing: { ...ZERO_TIMING, connectMaxAttempts: 3 },
        }),
      );
      expect(error._tag).toBe("AetherWorkspaceConnectTimeoutError");
      expect(fake.calls()).toBe(3);
    }),
  );
});

describe("aetherWorkspaceSocketUrl", () => {
  it("builds a wss URL with the key as the token query", () => {
    expect(
      aetherWorkspaceSocketUrl("https://api.runaether.dev", "/workspaces/ws-1/ws", "aether_k+y"),
    ).toBe("wss://api.runaether.dev/workspaces/ws-1/ws?token=aether_k%2By");
  });

  it("refuses protocol-relative and query-carrying paths", () => {
    expect(() =>
      aetherWorkspaceSocketUrl("https://api.runaether.dev", "//evil.example/ws", "k"),
    ).toThrow("same-origin");
    expect(() => aetherWorkspaceSocketUrl("https://api.runaether.dev", "/ws?x=1", "k")).toThrow(
      "no query",
    );
  });
});

// ---------------------------------------------------------------------------
// Socket loop
// ---------------------------------------------------------------------------

type Listener = (event: never) => void;

class FakeSocket implements AetherWebSocketLike {
  readonly sent: Array<string> = [];
  closed = false;
  /** When set, the socket errors instead of opening (upgrade failure). */
  failOpen = false;
  private opened = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(type, list);
    // The loop registers its open listener strictly after construction;
    // firing on registration models an already-open upgrade deterministically.
    if (type === "open" && this.opened) {
      (listener as () => void)();
    }
    // Same trick for a deterministic upgrade failure.
    if (type === "error" && this.failOpen) {
      (listener as (event: unknown) => void)(new Error("upgrade refused"));
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.fire("close", { code: 1000, reason: "client closed" });
  }

  open(): void {
    this.opened = true;
    this.fire("open", undefined);
  }

  serverClose(code: number, reason: string): void {
    this.closed = true;
    this.fire("close", { code, reason });
  }

  message(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) });
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

interface StreamHarness {
  readonly sockets: Array<FakeSocket>;
  readonly events: Array<AetherAgentEvent>;
  readonly ports: Array<AetherPortsMessage>;
  readonly dropped: Array<{ key: string; detail: string }>;
  readonly durableOnly: Array<string>;
  readonly connects: Array<number>;
  readonly connectRetries: Array<{ consecutiveFailures: number; detail: string }>;
  readonly options: AetherAgentStreamOptions;
}

function makeHarness(
  restClient: Pick<AetherRestClient, "getTask" | "connectWorkspace">,
  configureSocket?: (socket: FakeSocket, index: number) => void,
): StreamHarness {
  const sockets: Array<FakeSocket> = [];
  const events: Array<AetherAgentEvent> = [];
  const ports: Array<AetherPortsMessage> = [];
  const dropped: Array<{ key: string; detail: string }> = [];
  const durableOnly: Array<string> = [];
  const connects: Array<number> = [];
  const connectRetries: Array<{ consecutiveFailures: number; detail: string }> = [];
  return {
    sockets,
    events,
    ports,
    dropped,
    durableOnly,
    connects,
    connectRetries,
    options: {
      restClient,
      apiBaseUrl: "https://api.runaether.dev",
      apiKey: "aether_test_key",
      taskId: "task-1",
      timing: ZERO_TIMING,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        configureSocket?.(socket, sockets.length);
        sockets.push(socket);
        if (!socket.failOpen) {
          // Model an instantly-successful upgrade: the loop's open listener
          // fires on registration (see FakeSocket.addEventListener).
          socket.open();
        }
        return socket;
      },
      onConnected: () => Effect.sync(() => void connects.push(sockets.length)),
      onEvent: (event) => Effect.sync(() => void events.push(event)),
      onPortsMessage: (message) => Effect.sync(() => void ports.push(message)),
      onFrameDropped: (problem) => Effect.sync(() => void dropped.push({ ...problem })),
      onConnectRetry: (failure) => Effect.sync(() => void connectRetries.push({ ...failure })),
      onDurableOnly: (reason) => Effect.sync(() => void durableOnly.push(reason)),
    },
  };
}

const settlePump = Effect.gen(function* () {
  // Let the forked pump run through its queued signals; the zero-duration
  // clock adjustments release the zero backoff sleeps.
  for (let i = 0; i < 8; i++) {
    yield* TestClock.adjust("0 millis");
    yield* Effect.yieldNow;
  }
});

describe("runAetherAgentStream", () => {
  it.effect("attaches, subscribes, streams frames, and drops unknown kinds once", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        getTask: scriptedGetTask([taskProcessing]).getTask,
        connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
      });
      const fiber = yield* Effect.forkChild(runAetherAgentStream(harness.options));
      yield* settlePump;

      expect(harness.connects).toEqual([1]);
      const socket = harness.sockets[0]!;
      // Agent-channel subscription for exactly this task.
      expect(socket.sent[0]).toBe('{"channel":"agent","type":"subscribe","taskId":"task-1"}');

      socket.message(wsAssistantDelta);
      socket.message(wsUnknownKindFrame);
      socket.message(wsUnknownKindFrame);
      socket.message({ channel: "files", type: "change", path: "/x", action: "modify" });
      yield* settlePump;

      expect(harness.events).toHaveLength(1);
      expect(harness.events[0]).toMatchObject({ kind: "assistant_message.delta" });
      // Unknown kind: logged once, dropped, socket alive.
      expect(harness.dropped).toEqual([
        {
          key: "unknown-kind:usage.updated",
          detail: expect.stringContaining("usage.updated"),
        },
      ]);
      expect(socket.closed).toBe(false);

      yield* Fiber.interrupt(fiber);
      // Scope teardown closes the socket (session-scope ownership).
      expect(socket.closed).toBe(true);
    }),
  );

  it.effect("routes ports-channel frames (snapshot + open/close) to onPortsMessage", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        getTask: scriptedGetTask([taskProcessing]).getTask,
        connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
      });
      const fiber = yield* Effect.forkChild(runAetherAgentStream(harness.options));
      yield* settlePump;
      const socket = harness.sockets[0]!;

      socket.message({ channel: "ports", type: "snapshot", ports: [3000, 5173] });
      socket.message({ channel: "ports", type: "change", action: "open", port: 8080 });
      socket.message({ channel: "ports", type: "change", action: "close", port: 3000 });
      // A malformed ports frame is ignored, not routed.
      socket.message({ channel: "ports", type: "change", action: "open" });
      yield* settlePump;

      expect(harness.ports).toEqual([
        { _tag: "snapshot", ports: [3000, 5173] },
        { _tag: "change", action: "open", port: 8080 },
        { _tag: "change", action: "close", port: 3000 },
      ]);
      expect(socket.closed).toBe(false);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("reconnects after a server close: full re-attach + resubscribe + onConnected", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        getTask: scriptedGetTask([taskProcessing]).getTask,
        connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
      });
      const fiber = yield* Effect.forkChild(runAetherAgentStream(harness.options));
      yield* settlePump;
      expect(harness.connects).toEqual([1]);

      harness.sockets[0]!.serverClose(1006, "vm went away");
      yield* settlePump;

      // A second socket, resubscribed, and a second onConnected (which is
      // where the caller replays the durable delta from its cursor).
      expect(harness.sockets).toHaveLength(2);
      expect(harness.connects).toEqual([1, 2]);
      expect(harness.sockets[1]!.sent[0]).toBe(
        '{"channel":"agent","type":"subscribe","taskId":"task-1"}',
      );

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("settles into durable-only mode on a parked task with zero further polls", () =>
    Effect.gen(function* () {
      const fake = scriptedGetTask([taskParked]);
      const harness = makeHarness({
        getTask: fake.getTask,
        connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
      });
      // The pump ENDS on its own — no interrupt needed.
      yield* runAetherAgentStream(harness.options);
      expect(harness.durableOnly).toHaveLength(1);
      expect(harness.durableOnly[0]).toContain("awaiting input");
      expect(fake.calls()).toBe(1);
      expect(harness.sockets).toHaveLength(0);
      expect(harness.connects).toEqual([]);
    }),
  );

  it.effect("settles into durable-only mode when the workspace is not running", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        getTask: scriptedGetTask([taskProcessing]).getTask,
        connectWorkspace: scriptedConnect([
          { state: "conflict", conflict: { kind: "startable", error: "idle" } },
        ]).connectWorkspace,
      });
      yield* runAetherAgentStream(harness.options);
      expect(harness.durableOnly).toHaveLength(1);
      expect(harness.sockets).toHaveLength(0);
    }),
  );

  it.effect("propagates the errored-task failure instead of polling forever", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        getTask: scriptedGetTask([taskErrored]).getTask,
        connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
      });
      const error = yield* Effect.flip(runAetherAgentStream(harness.options));
      expect(error._tag).toBe("AetherTaskErroredError");
    }),
  );

  it.effect("fires onConnectRetry on open failures and keeps retrying until an open succeeds", () =>
    Effect.gen(function* () {
      const harness = makeHarness(
        {
          getTask: scriptedGetTask([taskProcessing]).getTask,
          connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
        },
        // The first two upgrades fail; the third opens.
        (socket, index) => {
          socket.failOpen = index < 2;
        },
      );
      const fiber = yield* Effect.forkChild(runAetherAgentStream(harness.options));
      yield* settlePump;

      // Each failed open surfaced the degradation (the caller reconciles the
      // durable feed on this beat) with a growing consecutive count, and the
      // loop still reached a successful attach — never a silent dead loop.
      expect(harness.connectRetries.map((retry) => retry.consecutiveFailures)).toEqual([1, 2]);
      expect(harness.connects).toEqual([3]);
      // The acquireRelease finalizer only registers after a successful open,
      // and open failures retry forever — every pre-open failure must close
      // its raw socket itself or each retry leaks one.
      expect(harness.sockets[0]!.closed).toBe(true);
      expect(harness.sockets[1]!.closed).toBe(true);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("surfaces server error-channel frames through onFrameDropped, once per detail", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        getTask: scriptedGetTask([taskProcessing]).getTask,
        connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
      });
      const fiber = yield* Effect.forkChild(runAetherAgentStream(harness.options));
      yield* settlePump;

      const socket = harness.sockets[0]!;
      // The workspace-service rejects a client message it cannot parse and
      // keeps the socket open — without surfacing this, the driver would sit
      // attached-but-mute with zero diagnostics.
      socket.message({ channel: "error", type: "error", error: "invalid subscribe message" });
      socket.message({ channel: "error", type: "error", error: "invalid subscribe message" });
      socket.message({ channel: "error", type: "error" });
      yield* settlePump;

      expect(harness.dropped).toEqual([
        {
          key: "server-error:invalid subscribe message",
          detail: expect.stringContaining("invalid subscribe message"),
        },
        {
          key: "server-error:server sent an error frame carrying no string `error` field",
          detail: expect.stringContaining("no string `error` field"),
        },
      ]);
      expect(socket.closed).toBe(false);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("re-enters the backoff ladder on a transport-class REST failure after connecting", () =>
    Effect.gen(function* () {
      const transportBlip = new AetherApiTransportError({
        endpoint: "GET /tasks/task-1",
        detail: "socket hang up",
      });
      // Attach OK → socket drops → re-attach getTask blips → next attempt OK.
      let getTaskCalls = 0;
      const answers: ReadonlyArray<AetherTask | AetherApiTransportError> = [
        taskProcessing,
        transportBlip,
        taskProcessing,
      ];
      const harness = makeHarness({
        getTask: () => {
          const answer = answers[Math.min(getTaskCalls, answers.length - 1)]!;
          getTaskCalls++;
          return "_tag" in answer ? Effect.fail(answer) : Effect.succeed(answer);
        },
        connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
      });
      const fiber = yield* Effect.forkChild(runAetherAgentStream(harness.options));
      yield* settlePump;
      expect(harness.connects).toEqual([1]);

      harness.sockets[0]!.serverClose(1006, "vm suspended");
      yield* settlePump;

      // The blip fired the retry surface instead of killing the pump, and
      // the following attempt re-attached.
      expect(harness.connectRetries).toEqual([
        { consecutiveFailures: 1, detail: expect.stringContaining("socket hang up") },
      ]);
      expect(harness.connects).toEqual([1, 2]);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("still fails loudly on a transport-class REST failure BEFORE the first connect", () =>
    Effect.gen(function* () {
      // A misconfigured base URL / dead API must surface at startSession,
      // not spin silently: the retry ladder only covers re-attach.
      const harness = makeHarness({
        getTask: () =>
          Effect.fail(
            new AetherApiTransportError({ endpoint: "GET /tasks/task-1", detail: "ECONNREFUSED" }),
          ),
        connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
      });
      const error = yield* Effect.flip(runAetherAgentStream(harness.options));
      expect(error._tag).toBe("AetherApiTransportError");
      expect(harness.connectRetries).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Git / files channel request-response correlation (T6 mirror sync transport)
// ---------------------------------------------------------------------------

const decodeSentRequestFrame = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.String,
      type: Schema.String,
      requestId: Schema.String,
      mode: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
    }),
  ),
);

describe("workspace request-response channel", () => {
  const connectedHarness = () => {
    const connections: Array<AetherAgentConnection> = [];
    const harness = makeHarness({
      getTask: scriptedGetTask([taskProcessing]).getTask,
      connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
    });
    const options: AetherAgentStreamOptions = {
      ...harness.options,
      onConnected: (connection) => Effect.sync(() => void connections.push(connection)),
    };
    return { harness, options, connections };
  };

  it.effect("correlates a git diff response by requestId", () =>
    Effect.gen(function* () {
      const { harness, options, connections } = connectedHarness();
      const fiber = yield* Effect.forkChild(runAetherAgentStream(options));
      yield* settlePump;
      const connection = connections[0]!;
      const socket = harness.sockets[0]!;

      const request = yield* Effect.forkChild(connection.requestGitDiff({ mode: "main" }));
      yield* settlePump;
      const sentFrame = socket.sent.find((frame) => frame.includes('"channel":"git"'));
      expect(sentFrame).toBeDefined();
      const parsed = decodeSentRequestFrame(sentFrame!);
      expect(parsed.type).toBe("diff");
      expect(parsed.mode).toBe("main");

      // An unmatched response is dropped, the matched one resolves.
      socket.message({
        channel: "git",
        type: "diff",
        requestId: "someone-else",
        success: true,
        diff: { baseRef: "bogus", files: [] },
      });
      socket.message({
        channel: "git",
        type: "diff",
        requestId: parsed.requestId,
        success: true,
        diff: { baseRef: "abc123", files: [] },
      });
      yield* settlePump;
      const diff = yield* Fiber.join(request);
      expect(diff).toEqual({ baseRef: "abc123", files: [] });

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("maps success:false, timeout, and socket-drop to typed errors", () =>
    Effect.gen(function* () {
      const { harness, options, connections } = connectedHarness();
      const fiber = yield* Effect.forkChild(runAetherAgentStream(options));
      yield* settlePump;
      const connection = connections[0]!;
      const socket = harness.sockets[0]!;

      // success:false → request-failed (the write-lock answer takes this shape).
      const failing = yield* Effect.forkChild(
        Effect.flip(connection.requestGitDiff({ mode: "main" })),
      );
      yield* settlePump;
      const failingId = decodeSentRequestFrame(socket.sent.at(-1)!).requestId;
      socket.message({
        channel: "git",
        type: "diff",
        requestId: failingId,
        success: false,
        error: "A git write operation is in progress, cannot read diff",
      });
      yield* settlePump;
      const failure = yield* Fiber.join(failing);
      expect(failure._tag).toBe("AetherWorkspaceRequestFailedError");
      expect(failure.message).toContain("write operation is in progress");

      // No answer → timeout after the request budget.
      const timing = yield* Effect.forkChild(
        Effect.flip(connection.requestGitDiff({ mode: "main" })),
      );
      yield* settlePump;
      yield* TestClock.adjust("31 seconds");
      const timeout = yield* Fiber.join(timing);
      expect(timeout._tag).toBe("AetherWorkspaceRequestTimeoutError");

      // Socket drop with a request in flight → typed detached failure.
      const dropped = yield* Effect.forkChild(Effect.flip(connection.readWorkspaceFile("a/b.bin")));
      yield* settlePump;
      socket.serverClose(1006, "gone");
      yield* settlePump;
      const detached = yield* Fiber.join(dropped);
      expect(detached._tag).toBe("AetherWorkspaceDetachedError");

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("a request issued from INSIDE onEvent resolves — no pump self-deadlock", () =>
    Effect.gen(function* () {
      // Regression: the mirror sync engine requests the git diff from inside
      // the turn-settle event handler (sync-then-settle). If frame routing
      // and event handling shared one fiber, the response frame would sit in
      // the signal queue behind the very handler awaiting it and EVERY
      // live-observed settle would stall for the full request timeout.
      const connections: Array<AetherAgentConnection> = [];
      const resolvedDiffs: Array<string> = [];
      const harness = makeHarness(
        {
          getTask: scriptedGetTask([taskProcessing]).getTask,
          connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
        },
        (socket) => {
          // The workspace side: answer every git diff request as soon as it
          // is sent (synchronously — the harshest ordering).
          const originalSend = socket.send.bind(socket);
          socket.send = (data: string) => {
            originalSend(data);
            const frame = JSON.parse(data) as { channel?: string; requestId?: string };
            if (frame.channel === "git" && typeof frame.requestId === "string") {
              socket.message({
                channel: "git",
                type: "diff",
                requestId: frame.requestId,
                success: true,
                diff: { baseRef: "abc123", files: [] },
              });
            }
          };
        },
      );
      const options: AetherAgentStreamOptions = {
        ...harness.options,
        onConnected: (connection) => Effect.sync(() => void connections.push(connection)),
        onEvent: () =>
          Effect.gen(function* () {
            // orDie: a timeout HERE is exactly the deadlock this test guards
            // against — it must crash the test, never be swallowed.
            const diff = yield* Effect.orDie(connections[0]!.requestGitDiff({ mode: "main" }));
            resolvedDiffs.push(diff.baseRef);
          }),
      };
      const fiber = yield* Effect.forkChild(runAetherAgentStream(options));
      yield* settlePump;

      // Two settles in a row: each handler's request must resolve without
      // ANY clock advancement (the request timeout never fires) and the pump
      // must keep flowing to the next event.
      harness.sockets[0]!.message(wsAssistantDelta);
      yield* settlePump;
      harness.sockets[0]!.message(wsAssistantDelta);
      yield* settlePump;
      expect(resolvedDiffs).toEqual(["abc123", "abc123"]);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect(
    "a request issued from INSIDE onConnected resolves — the router drains first",
    () =>
      Effect.gen(function* () {
        // Regression: onConnected drives the reconcile, which can settle a
        // turn and (through the mirror sync) request the git diff. With the
        // router forked only AFTER onConnected returned, that response sat
        // unconsumed in the signal queue while onConnected awaited it —
        // every reconnect-with-a-pending-settle deadlocked for the full
        // request timeout.
        const resolvedDiffs: Array<string> = [];
        const harness = makeHarness(
          {
            getTask: scriptedGetTask([taskProcessing]).getTask,
            connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
          },
          (socket) => {
            // The workspace side answers every git diff request synchronously
            // — the harshest ordering for the drain loop.
            const originalSend = socket.send.bind(socket);
            socket.send = (data: string) => {
              originalSend(data);
              const frame = JSON.parse(data) as { channel?: string; requestId?: string };
              if (frame.channel === "git" && typeof frame.requestId === "string") {
                socket.message({
                  channel: "git",
                  type: "diff",
                  requestId: frame.requestId,
                  success: true,
                  diff: { baseRef: "abc123", files: [] },
                });
              }
            };
          },
        );
        const options: AetherAgentStreamOptions = {
          ...harness.options,
          onConnected: (connection) =>
            Effect.gen(function* () {
              // orDie: a timeout HERE is exactly the deadlock under test.
              const diff = yield* Effect.orDie(connection.requestGitDiff({ mode: "main" }));
              resolvedDiffs.push(diff.baseRef);
            }),
        };
        const fiber = yield* Effect.forkChild(runAetherAgentStream(options));
        yield* settlePump;
        // Resolved without ANY clock advancement (the request timeout never
        // fired), and the pump went on to handle live frames normally.
        expect(resolvedDiffs).toEqual(["abc123"]);

        harness.sockets[0]!.message(wsAssistantDelta);
        yield* settlePump;
        expect(harness.events).toHaveLength(1);

        // The same on RECONNECT: the second attach's onConnected must not
        // hang either.
        harness.sockets[0]!.serverClose(1006, "vm went away");
        yield* settlePump;
        expect(resolvedDiffs).toEqual(["abc123", "abc123"]);

        yield* Fiber.interrupt(fiber);
      }),
    // A regression deadlocks instead of failing an assertion: cap it so the
    // suite fails fast rather than hanging.
    { timeout: 15_000 },
  );

  it.effect(
    "fails an onConnected request IMMEDIATELY when the server closed right after open",
    () =>
      Effect.gen(function* () {
        // `WebSocket.send()` silently discards data once the socket is
        // CLOSING/CLOSED, so a non-throwing subscribe is no proof of a live
        // connection. Before the detached latch, the reconcile onConnected
        // starts issued a request nothing could ever answer and waited the
        // full 30s request budget before the queued close could be consumed
        // and the reconnect begin.
        const outcomes: Array<string> = [];
        const harness = makeHarness(
          {
            getTask: scriptedGetTask([taskProcessing]).getTask,
            connectWorkspace: scriptedConnect([runningOutcome]).connectWorkspace,
          },
          (socket, index) => {
            if (index !== 0) {
              return;
            }
            const originalSend = socket.send.bind(socket);
            socket.send = (data: string) => {
              originalSend(data);
              socket.serverClose(1006, "closed right after open");
            };
          },
        );
        const options: AetherAgentStreamOptions = {
          ...harness.options,
          onConnected: (connection) =>
            Effect.gen(function* () {
              const result = yield* Effect.result(connection.requestGitDiff({ mode: "main" }));
              outcomes.push(Result.isFailure(result) ? result.failure._tag : "unexpected-success");
            }),
        };
        const fiber = yield* Effect.forkChild(runAetherAgentStream(options));
        yield* settlePump;
        // No clock advancement: the request budget never fired, the close did.
        expect(outcomes[0]).toBe("AetherWorkspaceDetachedError");
        // And the drop was observed, so the loop reconnected.
        expect(harness.sockets.length).toBeGreaterThan(1);

        yield* Fiber.interrupt(fiber);
      }),
    // A regression stalls for the request timeout instead of asserting.
    { timeout: 15_000 },
  );

  it.effect("reads a workspace file over the files channel", () =>
    Effect.gen(function* () {
      const { harness, options, connections } = connectedHarness();
      const fiber = yield* Effect.forkChild(runAetherAgentStream(options));
      yield* settlePump;
      const connection = connections[0]!;
      const socket = harness.sockets[0]!;

      const request = yield* Effect.forkChild(connection.readWorkspaceFile("assets/logo.png"));
      yield* settlePump;
      const frame = decodeSentRequestFrame(socket.sent.at(-1)!);
      expect(frame).toMatchObject({ channel: "files", type: "read", path: "assets/logo.png" });
      socket.message({
        channel: "files",
        type: "read",
        requestId: frame.requestId,
        success: true,
        path: "assets/logo.png",
        content: "aGVsbG8=",
        encoding: "base64",
        size: 5,
        modified: "2026-08-08T10:00:00Z",
        isBinary: true,
      });
      yield* settlePump;
      const read = yield* Fiber.join(request);
      expect(read).toMatchObject({ content: "aGVsbG8=", encoding: "base64", isBinary: true });

      yield* Fiber.interrupt(fiber);
    }),
  );
});
