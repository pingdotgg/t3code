// @effect-diagnostics globalDate:off globalTimers:off - Transport tests use short deterministic waits.
import { describe, expect, it } from "vite-plus/test";

import {
  HermesGatewayCapabilityError,
  HermesGatewayClient,
  HermesGatewayConfigurationError,
  HermesGatewayConnectionError,
  HermesGatewayMutationIndeterminateError,
  HermesGatewayMutationsBlockedError,
  classifyHermesGatewayReady,
  type HermesGatewayLogEvent,
  type HermesGatewaySocket,
  type HermesGatewaySocketEvent,
} from "./HermesGatewayClient.ts";

class FakeSocket implements HermesGatewaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ readonly code: number; readonly reason?: string }> = [];
  readonly endpoint: string;
  private readonly listeners = new Map<
    "open" | "message" | "close" | "error",
    Array<{ readonly listener: (event: HermesGatewaySocketEvent) => void; readonly once: boolean }>
  >();

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  close(code = 1000, reason?: string): void {
    this.closeCalls.push({ code, ...(reason === undefined ? {} : { reason }) });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code });
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: HermesGatewaySocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener, once: options?.once === true });
    this.listeners.set(type, entries);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  fail(): void {
    this.emit("error", {});
  }

  private emit(
    type: "open" | "message" | "close" | "error",
    event: HermesGatewaySocketEvent,
  ): void {
    const entries = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(
      type,
      entries.filter((entry) => !entry.once),
    );
    for (const entry of entries) entry.listener(event);
  }
}

class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];

  readonly create = (endpoint: string): FakeSocket => {
    const socket = new FakeSocket(endpoint);
    this.sockets.push(socket);
    return socket;
  };
}

const legacyReady = {
  jsonrpc: "2.0",
  method: "event",
  params: {
    type: "gateway.ready",
    payload: { skin: "default" },
  },
} as const;

const stableMutationReady = {
  jsonrpc: "2.0",
  method: "event",
  params: {
    type: "gateway.ready",
    payload: {
      protocol: {
        major: 1,
        minor: 0,
        capabilities: {
          "mutation.stable_ids": "durable-v1",
          "session.lifecycle": "supported",
          "turn.interrupt": "supported",
          "turn.prompt": "supported",
        },
      },
    },
  },
} as const;

const fullyNegotiatedReady = {
  jsonrpc: "2.0",
  method: "event",
  params: {
    type: "gateway.ready",
    payload: {
      protocol: {
        major: 1,
        minor: 0,
        capabilities: Object.fromEntries(
          [
            "session.lifecycle",
            "session.history",
            "session.title",
            "session.branch.latest",
            "turn.prompt",
            "turn.interrupt",
            "commands.catalog",
            "models.inventory",
            "reasoning.effective_state",
            "attachments.image",
            "attachments.file",
            "attachments.pdf",
            "cron.read",
            "cron.manage",
            "profile.import",
          ].map((capability) => [capability, "supported"]),
        ),
      },
    },
  },
} as const;

function success(id: string, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function sentFrames(socket: FakeSocket): Array<{
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}> {
  return socket.sent.map((frame) => JSON.parse(frame));
}

async function openClient(
  factory: FakeSocketFactory,
  options: Partial<ConstructorParameters<typeof HermesGatewayClient>[0]> = {},
  readyFrame: unknown = fullyNegotiatedReady,
): Promise<{ readonly client: HermesGatewayClient; readonly socket: FakeSocket }> {
  const client = new HermesGatewayClient({
    endpoint: "ws://127.0.0.1:9119/api/ws",
    authToken: "private-token",
    socketFactory: factory.create,
    reconnect: { maxAttempts: 0 },
    ...options,
  });
  const connecting = client.connect();
  await Promise.resolve();
  const socket = factory.sockets[0]!;
  socket.open();
  await Promise.resolve();
  socket.receive(readyFrame);
  await connecting;
  return { client, socket };
}

describe("HermesGatewayClient transport security", () => {
  it("registers and revokes an ephemeral session MCP lease", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(
      factory,
      {},
      {
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "gateway.ready",
          payload: {
            protocol: {
              major: 1,
              minor: 0,
              capabilities: {
                session_mcp: "ephemeral-lease-v1",
              },
            },
          },
        },
      },
    );

    const replacing = client.replaceSessionMcp(
      {
        session_id: "live-1",
        servers: {
          "t3-code": {
            url: "http://127.0.0.1:43123/mcp",
            headers: { Authorization: "Bearer scoped-token" },
          },
        },
      },
      { operationId: "mcp-replace" },
    );
    let frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "session.mcp.replace",
      params: {
        session_id: "live-1",
        servers: {
          "t3-code": {
            url: "http://127.0.0.1:43123/mcp",
            headers: { Authorization: "Bearer scoped-token" },
          },
        },
      },
    });
    socket.receive(
      success(frame.id, {
        lease_id: "lease-1",
        generation: 1,
        servers: [{ name: "t3-code", runtime_name: "tui_session_lease_t3_code" }],
        tool_names: ["mcp__tui_session_lease_t3_code__delegate_task"],
        scope: { session_id: "live-1", session_key: "stored-1" },
        persisted: false,
        history_recorded: false,
      }),
    );
    await expect(replacing).resolves.toMatchObject({ lease_id: "lease-1", generation: 1 });

    const revoking = client.revokeSessionMcp("live-1", { operationId: "mcp-revoke" });
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "session.mcp.revoke",
      params: { session_id: "live-1" },
    });
    socket.receive(
      success(frame.id, {
        revoked: true,
        lease_id: "lease-1",
        persisted: false,
      }),
    );
    await expect(revoking).resolves.toEqual({
      revoked: true,
      lease_id: "lease-1",
      persisted: false,
    });
    client.close();
  });

  it("requires authenticated loopback ws by default and never logs credentials", async () => {
    expect(
      () =>
        new HermesGatewayClient({
          endpoint: "ws://example.com/api/ws",
          authToken: "private-token",
        }),
    ).toThrow(HermesGatewayConfigurationError);
    expect(
      () =>
        new HermesGatewayClient({
          endpoint: "ws://localhost:9119/api/ws",
          authToken: "",
        }),
    ).toThrow(HermesGatewayConfigurationError);

    const logs: HermesGatewayLogEvent[] = [];
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      logger: (event) => logs.push(event),
    });
    const request = client.mutate(
      "prompt.submit",
      { session_id: "session-1", text: "PRIVATE PROMPT" },
      { operationId: "operation-1" },
    );
    const frame = sentFrames(socket)[0]!;
    socket.receive(success(frame.id, { text: "PRIVATE RESULT" }));
    await request;

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain("private-token");
    expect(serializedLogs).not.toContain("PRIVATE PROMPT");
    expect(serializedLogs).not.toContain("PRIVATE RESULT");
    expect(serializedLogs).toContain("%3Credacted%3E");
    client.close();
  });
});

describe("HermesGatewayClient protocol and ordering", () => {
  it("does not manufacture optional or mutating capabilities for legacy gateways", () => {
    expect(classifyHermesGatewayReady(legacyReady).capabilities).toEqual([]);
  });

  it("publishes negotiated version, capability, and reconnect health", async () => {
    const factory = new FakeSocketFactory();
    const client = new HermesGatewayClient({
      endpoint: "ws://localhost:9119/api/ws?label=private-value",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
    });
    const health: unknown[] = [];
    client.onHealthChange((snapshot) => health.push(snapshot));
    const connecting = client.connect();
    await Promise.resolve();
    const socket = factory.sockets[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive({
      ...stableMutationReady,
      params: {
        ...stableMutationReady.params,
        payload: {
          ...stableMutationReady.params.payload,
          server_version: "1.3.0",
        },
      },
    });
    await connecting;

    expect(client.health).toMatchObject({
      state: "ready",
      reconnectAttempt: 0,
      protocolStatus: "supported",
      protocolMajor: 1,
      protocolMinor: 0,
      serverVersion: "1.3.0",
      writesBlocked: false,
      indeterminateMutationCount: 0,
    });
    expect(client.health.capabilities).toEqual([
      "mutation.stable_ids",
      "session.lifecycle",
      "turn.interrupt",
      "turn.prompt",
    ]);
    expect(health).toHaveLength(3);
    client.close();
  });

  it("uses the pinned cron.manage list/add/remove wire protocol", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);

    const listing = client.listCronJobs();
    let frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({ method: "cron.manage", params: { action: "list" } });
    socket.receive(success(frame.id, { success: true, jobs: [] }));
    await expect(listing).resolves.toEqual({ success: true, jobs: [] });

    const adding = client.manageCron(
      { action: "add", name: "job", schedule: "0 0 * * *", prompt: "check" },
      { operationId: "cron-add-1" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "cron.manage",
      params: { action: "add", name: "job", schedule: "0 0 * * *", prompt: "check" },
    });
    socket.receive(success(frame.id, { success: true, job_id: "job-1" }));
    await expect(adding).resolves.toEqual({ success: true, job_id: "job-1" });
    client.close();
  });

  it("correlates out-of-order responses while serializing events in wire order", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);
    const observed: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    client.onEvent(async (event) => {
      observed.push(`start:${event.sessionSequence}:${event.frame.params.type}`);
      if (event.frame.params.type === "message.delta") await firstMayFinish;
      observed.push(`end:${event.sessionSequence}:${event.frame.params.type}`);
    });

    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.delta",
        session_id: "session-1",
        payload: { text: "first" },
      },
    });
    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.complete",
        session_id: "session-1",
        payload: { text: "second" },
      },
    });
    await eventually(() => observed.length === 1);
    expect(observed).toEqual(["start:1:message.delta"]);
    releaseFirst();
    await eventually(() => observed.length === 4);
    expect(observed).toEqual([
      "start:1:message.delta",
      "end:1:message.delta",
      "start:2:message.complete",
      "end:2:message.complete",
    ]);

    const sessions = client.read("session.list", {});
    const history = client.read("session.history", { session_id: "session-1" });
    const frames = sentFrames(socket);
    socket.receive(success(frames[1]!.id, { count: 3 }));
    socket.receive(success(frames[0]!.id, { sessions: [] }));
    await expect(history).resolves.toEqual({ count: 3 });
    await expect(sessions).resolves.toEqual({ sessions: [] });
    client.close();
  });

  it("preserves negotiated event identities and rejects unsupported protocol majors", async () => {
    const factory = new FakeSocketFactory();
    const client = new HermesGatewayClient({
      endpoint: "ws://localhost:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
    });
    const events: unknown[] = [];
    client.onEvent((event) => {
      events.push(event);
    });
    const connecting = client.connect();
    await Promise.resolve();
    const socket = factory.sockets[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "gateway.ready",
        payload: {
          protocol: {
            major: 1,
            minor: 4,
            build_revision: "upstream-revision",
            capabilities: {
              version: "1",
              "session.lifecycle": "supported",
              "event.stable_ids": "supported",
              "attachments.pdf": "unsupported",
              branching: { mode: "latest", stable_boundaries: false },
            },
          },
        },
        event_id: "ready-event",
        event_sequence: 7,
        emitted_at: "2026-07-24T00:00:00Z",
        session_key: "durable-1",
        run_id: "run-1",
        message_id: "message-1",
      },
    });
    const compatibility = await connecting;
    expect(compatibility.status).toBe("supported");
    expect(client.hasCapability("event.stable_ids")).toBe(true);
    expect(client.hasCapability("attachments.pdf")).toBe(false);
    expect(client.hasCapability("branching")).toBe(true);
    expect(compatibility.inventory).toMatchObject({
      version: "1",
      branching: { mode: "latest", stable_boundaries: false },
    });
    await eventually(() => events.length === 1);
    expect(events[0]).toMatchObject({
      eventId: "ready-event",
      eventSequence: 7,
      cursor: 7,
      emittedAt: "2026-07-24T00:00:00Z",
      sessionKey: "durable-1",
      runId: "run-1",
      messageId: "message-1",
    });
    client.close();

    const rejectedFactory = new FakeSocketFactory();
    const rejected = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: rejectedFactory.create,
      reconnect: { maxAttempts: 0 },
    });
    const rejection = rejected.connect();
    await Promise.resolve();
    rejectedFactory.sockets[0]!.open();
    await Promise.resolve();
    rejectedFactory.sockets[0]!.receive({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "gateway.ready",
        payload: {
          protocol: {
            major: 2,
            minor: 0,
            build_revision: "future",
            capabilities: {
              version: "1",
              "session.lifecycle": "supported",
            },
          },
        },
      },
    });
    await expect(rejection).rejects.toThrow("Unsupported Hermes gateway protocol major 2");
    expect(rejectedFactory.sockets[0]!.closeCalls).toEqual([
      { code: 4002, reason: "gateway handshake failed" },
    ]);
  });

  it("degrades a missing optional RPC independently", async () => {
    const logs: HermesGatewayLogEvent[] = [];
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      logger: (event) => logs.push(event),
    });
    const commands = client.read("commands.catalog", {});
    const frame = sentFrames(socket)[0]!;
    socket.receive({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32601, message: "PRIVATE METHOD ERROR" },
    });
    await expect(commands).rejects.toMatchObject({ code: -32601 });
    expect(client.hasCapability("commands.catalog")).toBe(false);
    expect(client.hasCapability("session.history")).toBe(true);
    await expect(client.read("commands.catalog", {})).rejects.toBeInstanceOf(
      HermesGatewayCapabilityError,
    );
    expect(JSON.stringify(logs)).not.toContain("PRIVATE METHOD ERROR");
    client.close();
  });

  it("degrades cron.read when the cron list read is unimplemented", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);
    const listing = client.listCronJobs();
    const frame = sentFrames(socket).at(-1)!;
    socket.receive({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32601, message: "method not found" },
    });
    await expect(listing).rejects.toMatchObject({ code: -32601 });
    expect(client.hasCapability("cron.read")).toBe(false);
    expect(client.hasCapability("cron.manage")).toBe(true);
    await expect(client.listCronJobs()).rejects.toBeInstanceOf(HermesGatewayCapabilityError);
    client.close();
  });

  it("dispatches events to remaining listeners when one listener fails", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);
    const observed: string[] = [];
    client.onEvent(() => {
      throw new Error("listener failure");
    });
    client.onEvent(async () => {
      await Promise.reject(new Error("async listener failure"));
    });
    client.onEvent((event) => {
      observed.push(`${event.sessionSequence}:${event.frame.params.type}`);
    });

    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "session-1", payload: { text: "one" } },
    });
    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.complete", session_id: "session-1", payload: { text: "two" } },
    });
    await eventually(() => observed.length === 2);
    expect(observed).toEqual(["1:message.delta", "2:message.complete"]);
    client.close();
  });

  it("exposes typed H4 session and prompt helpers", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);

    const createdPromise = client.createSession(
      { source: "t3-work", close_on_disconnect: false },
      { operationId: "create-operation" },
    );
    let frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        session_id: "live-1",
        stored_session_id: "durable-1",
        message_count: 0,
        messages: [],
        info: { model: "test-model", lazy: true },
      }),
    );
    await expect(createdPromise).resolves.toMatchObject({
      session_id: "live-1",
      stored_session_id: "durable-1",
    });

    const resumedPromise = client.resumeSession(
      { session_id: "durable-1", close_on_disconnect: false },
      { operationId: "resume-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        session_id: "live-2",
        resumed: "durable-1",
        message_count: 1,
        messages: [{ message_id: "message-restored", role: "assistant", text: "restored" }],
        info: {
          model: "test-model",
          title_revision: 3,
          title_origin: "agent",
        },
        running: false,
        session_key: "durable-1",
        started_at: 1,
        status: "idle",
      }),
    );
    await expect(resumedPromise).resolves.toMatchObject({
      session_id: "live-2",
      session_key: "durable-1",
      messages: [{ message_id: "message-restored" }],
      info: { title_revision: 3, title_origin: "agent" },
    });

    const statusPromise = client.readSessionStatus({ session_id: "live-2" });
    frame = sentFrames(socket).at(-1)!;
    socket.receive(success(frame.id, { output: "sanitized status" }));
    await expect(statusPromise).resolves.toEqual({ output: "sanitized status" });

    const historyPromise = client.readSessionHistory({ session_id: "live-2" });
    frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        count: 1,
        messages: [{ role: "assistant", text: "restored" }],
      }),
    );
    await expect(historyPromise).resolves.toMatchObject({ count: 1 });

    const imagePromise = client.attachImageBytes(
      {
        session_id: "live-2",
        content_base64: "iVBORw==",
        filename: "image.png",
      },
      { operationId: "image-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "image.attach_bytes",
      params: {
        session_id: "live-2",
        content_base64: "iVBORw==",
        filename: "image.png",
      },
    });
    socket.receive(success(frame.id, { attached: true, count: 1 }));
    await expect(imagePromise).resolves.toEqual({ attached: true, count: 1 });

    const filePromise = client.attachFile(
      { session_id: "live-2", name: "notes.txt", data_url: "data:text/plain;base64,YQ==" },
      { operationId: "file-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "file.attach",
      params: {
        session_id: "live-2",
        name: "notes.txt",
        data_url: "data:text/plain;base64,YQ==",
      },
    });
    socket.receive(success(frame.id, { attached: true }));
    await expect(filePromise).resolves.toEqual({ attached: true });

    const pdfPromise = client.attachPdf(
      { session_id: "live-2", filename: "report.pdf", content_base64: "JVBERg==" },
      { operationId: "pdf-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "pdf.attach",
      params: {
        session_id: "live-2",
        filename: "report.pdf",
        content_base64: "JVBERg==",
      },
    });
    socket.receive(success(frame.id, { attached: true }));
    await expect(pdfPromise).resolves.toEqual({ attached: true });

    const promptPromise = client.submitPrompt(
      { session_id: "live-2", text: "private" },
      { operationId: "prompt-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame.method).toBe("prompt.submit");
    socket.receive(
      success(frame.id, {
        status: "streaming",
        run_id: "run-1",
        user_message_id: "message-user",
        assistant_message_id: "message-assistant",
        mutation_id: "mutation-1",
        replayed: false,
        mutation_status: "admitted",
      }),
    );
    await expect(promptPromise).resolves.toEqual({
      status: "streaming",
      run_id: "run-1",
      user_message_id: "message-user",
      assistant_message_id: "message-assistant",
      mutation_id: "mutation-1",
      replayed: false,
      mutation_status: "admitted",
    });

    const interruptPromise = client.interruptSession(
      { session_id: "live-2" },
      { operationId: "interrupt-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame.method).toBe("session.interrupt");
    socket.receive(success(frame.id, { status: "interrupted" }));
    await expect(interruptPromise).resolves.toEqual({ status: "interrupted" });
    client.close();
  });

  it("decodes profile-scoped durable session discovery", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);

    const listed = client.listSessions({ profile: "work", limit: 20 });
    const request = sentFrames(socket).at(-1)!;
    expect(request).toMatchObject({
      method: "session.list",
      params: { profile: "work", limit: 20 },
    });
    socket.receive(
      success(request.id, {
        sessions: [
          {
            id: "stored-1",
            title: "Imported",
            preview: "hello",
            started_at: 123,
            message_count: 2,
            source: "tui",
          },
        ],
      }),
    );

    await expect(listed).resolves.toEqual({
      sessions: [
        {
          id: "stored-1",
          title: "Imported",
          preview: "hello",
          started_at: 123,
          message_count: 2,
          source: "tui",
        },
      ],
    });
    client.close();
  });
});

describe("HermesGatewayClient recovery", () => {
  it("coalesces concurrent initial connects onto one socket", async () => {
    const factory = new FakeSocketFactory();
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
    });

    const first = client.connect();
    const second = client.connect();
    await Promise.resolve();
    expect(factory.sockets).toHaveLength(1);
    factory.sockets[0]!.open();
    await Promise.resolve();
    factory.sockets[0]!.receive(legacyReady);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(factory.sockets).toHaveLength(1);
    client.close();
  });

  it("transitions to disconnected when the socket factory throws", async () => {
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: () => {
        throw new Error("socket construction refused");
      },
      reconnect: { maxAttempts: 0 },
    });
    await expect(client.connect()).rejects.toThrow("socket construction refused");
    expect(client.health.state).toBe("disconnected");
    client.close();
  });

  it("rejects connect when the socket never emits open", async () => {
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: () => ({
        readyState: 0,
        addEventListener: () => {},
        send: () => {},
        close: () => {},
      }),
      reconnect: { maxAttempts: 0 },
      openTimeoutMs: 5,
    });

    await expect(client.connect()).rejects.toThrow("Timed out opening gateway connection.");
    expect(client.health.state).toBe("disconnected");
    client.close();
  });

  it("queues reconnect-time reads and permits a known-unsent mutation retry", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    socket.close(1006);

    const read = client.read("session.list", {});
    await expect(
      client.mutate(
        "prompt.submit",
        { session_id: "session-1", text: "private" },
        { operationId: "retry-after-reconnect" },
      ),
    ).rejects.toThrow("not ready");
    expect(client.mutationRecord("retry-after-reconnect")?.state).toBe("not_sent");

    await eventually(() => factory.sockets.length === 2);
    const replacement = factory.sockets[1]!;
    replacement.open();
    await Promise.resolve();
    replacement.receive(fullyNegotiatedReady);
    await eventually(() => replacement.sent.length === 1);
    const replayedRead = sentFrames(replacement)[0]!;
    expect(replayedRead.method).toBe("session.list");
    replacement.receive(success(replayedRead.id, { sessions: [] }));
    await expect(read).resolves.toEqual({ sessions: [] });

    const retried = client.mutate(
      "prompt.submit",
      { session_id: "session-1", text: "private" },
      { operationId: "retry-after-reconnect" },
    );
    const retriedFrame = sentFrames(replacement)[1]!;
    expect(retriedFrame.method).toBe("prompt.submit");
    replacement.receive(success(retriedFrame.id, { status: "streaming" }));
    await expect(retried).resolves.toEqual({ status: "streaming" });
    expect(client.mutationRecord("retry-after-reconnect")?.state).toBe("confirmed");
    client.close();
  });

  it("fails a queued read locally when the reconnected gateway drops its capability", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    socket.close(1006);

    const read = client.read("cron.list", {}, { requiredCapability: "cron.read" });
    await eventually(() => factory.sockets.length === 2);
    const replacement = factory.sockets[1]!;
    replacement.open();
    await Promise.resolve();
    replacement.receive(stableMutationReady);

    await expect(read).rejects.toBeInstanceOf(HermesGatewayCapabilityError);
    expect(replacement.sent).toHaveLength(0);
    client.close();
  });

  it("still reconnects when a health listener throws during disconnect", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const seen: string[] = [];
    client.onHealthChange((snapshot) => {
      if (snapshot.state !== "ready") throw new Error("listener failure");
    });
    client.onHealthChange((snapshot) => seen.push(snapshot.state));
    socket.close(1006);

    await eventually(() => factory.sockets.length === 2);
    const replacement = factory.sockets[1]!;
    replacement.open();
    await Promise.resolve();
    replacement.receive(fullyNegotiatedReady);
    await eventually(() => client.state === "ready");
    expect(seen).toContain("reconnecting");
    expect(seen).toContain("ready");
    client.close();
  });

  it("aborts a connect attempt when close() lands while onConnected is pending", async () => {
    const factory = new FakeSocketFactory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
      supervisor: { onConnected: () => gate },
    });
    const connecting = client.connect();
    await Promise.resolve();
    const socket = factory.sockets[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive(fullyNegotiatedReady);
    await eventually(() => client.state === "ready");
    client.close();
    release();
    await expect(connecting).rejects.toBeInstanceOf(HermesGatewayConnectionError);
    expect(client.state).toBe("closed");
  });

  it("uses mutation.status to release only an authoritatively completed local fence", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {}, stableMutationReady);
    const prompt = client.submitPrompt(
      { session_id: "session-1", text: "private" },
      {
        operationId: "prompt-recovery-operation",
        mutationId: "prompt-recovery-mutation",
      },
    );
    let frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        mutation_id: "prompt-recovery-mutation",
        mutation_status: "indeterminate",
        run_id: "run-recovery",
        replayed: true,
      }),
    );
    await expect(prompt).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);

    const reconciliation = client.reconcileMutation(
      "prompt-recovery-operation",
      "prompt-recovery-mutation",
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "mutation.status",
      params: { mutation_id: "prompt-recovery-mutation" },
    });
    const health: Array<{ writesBlocked: boolean; indeterminateMutationCount: number }> = [];
    client.onHealthChange((snapshot) =>
      health.push({
        writesBlocked: snapshot.writesBlocked,
        indeterminateMutationCount: snapshot.indeterminateMutationCount,
      }),
    );
    expect(health.at(-1)).toEqual({ writesBlocked: true, indeterminateMutationCount: 1 });
    socket.receive(success(frame.id, { mutation_status: "completed" }));

    await expect(reconciliation).resolves.toEqual({ mutation_status: "completed" });
    expect(client.mutationRecord("prompt-recovery-operation")).toBeUndefined();
    expect(client.writesBlocked).toBe(false);
    expect(health.at(-1)).toEqual({ writesBlocked: false, indeterminateMutationCount: 0 });
    client.close();
  });

  it("keeps the local fence for a mutation reconciled as still admitted", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {}, stableMutationReady);
    const prompt = client.submitPrompt(
      { session_id: "session-1", text: "private" },
      {
        operationId: "prompt-admitted-operation",
        mutationId: "prompt-admitted-mutation",
      },
    );
    let frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        mutation_id: "prompt-admitted-mutation",
        mutation_status: "indeterminate",
        run_id: "run-admitted",
        replayed: true,
      }),
    );
    await expect(prompt).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);

    const reconciliation = client.reconcileMutation(
      "prompt-admitted-operation",
      "prompt-admitted-mutation",
    );
    frame = sentFrames(socket).at(-1)!;
    socket.receive(success(frame.id, { mutation_status: "admitted" }));
    await expect(reconciliation).resolves.toEqual({ mutation_status: "admitted" });

    expect(client.mutationRecord("prompt-admitted-operation")?.state).toBe("pending");
    expect(client.writesBlocked).toBe(false);
    await expect(
      client.submitPrompt(
        { session_id: "session-1", text: "must not race" },
        { operationId: "prompt-admitted-operation" },
      ),
    ).rejects.toThrow("already been used");
    client.close();
  });

  it("defaults reconciliation to the stored mutationId for the operation", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {}, stableMutationReady);
    const prompt = client.submitPrompt(
      { session_id: "session-1", text: "private" },
      {
        operationId: "prompt-stored-operation",
        mutationId: "prompt-stored-mutation",
      },
    );
    let frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        mutation_id: "prompt-stored-mutation",
        mutation_status: "indeterminate",
        run_id: "run-stored",
        replayed: true,
      }),
    );
    await expect(prompt).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);

    const reconciliation = client.reconcileMutation("prompt-stored-operation");
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "mutation.status",
      params: { mutation_id: "prompt-stored-mutation" },
    });
    socket.receive(success(frame.id, { mutation_status: "completed" }));
    await expect(reconciliation).resolves.toEqual({ mutation_status: "completed" });
    client.close();
  });

  it("does not release the fence when reconciling an unrelated mutation id", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {}, stableMutationReady);
    const prompt = client.submitPrompt(
      { session_id: "session-1", text: "private" },
      {
        operationId: "prompt-fenced-operation",
        mutationId: "prompt-fenced-mutation",
      },
    );
    let frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        mutation_id: "prompt-fenced-mutation",
        mutation_status: "indeterminate",
        run_id: "run-fenced",
        replayed: true,
      }),
    );
    await expect(prompt).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);

    const reconciliation = client.reconcileMutation("prompt-fenced-operation", "other-mutation");
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "mutation.status",
      params: { mutation_id: "other-mutation" },
    });
    socket.receive(success(frame.id, { mutation_status: "completed" }));
    await expect(reconciliation).resolves.toEqual({ mutation_status: "completed" });

    expect(client.mutationRecord("prompt-fenced-operation")?.state).toBe("indeterminate");
    expect(client.writesBlocked).toBe(true);
    client.close();
  });

  it("rejects sent mutations as indeterminate when the client is closed", async () => {
    const factory = new FakeSocketFactory();
    const { client } = await openClient(factory, {}, stableMutationReady);
    const prompt = client.submitPrompt(
      { session_id: "session-1", text: "private" },
      { operationId: "prompt-closed-operation" },
    );
    const read = client.readSessionStatus({ session_id: "session-1" });
    client.close();
    await expect(prompt).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);
    await expect(read).rejects.toBeInstanceOf(HermesGatewayConnectionError);
    expect(client.mutationRecord("prompt-closed-operation")?.state).toBe("indeterminate");
  });

  it("does not resurrect a client closed while beforeConnect is pending", async () => {
    const factory = new FakeSocketFactory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
      supervisor: { beforeConnect: () => gate },
    });
    const connecting = client.connect();
    client.close();
    release();
    await expect(connecting).rejects.toBeInstanceOf(HermesGatewayConnectionError);
    expect(factory.sockets).toHaveLength(0);
    expect(client.state).toBe("closed");
  });

  it("rejects an in-flight connect() when close() is called mid-handshake", async () => {
    const factory = new FakeSocketFactory();
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
    });
    const connecting = client.connect();
    await Promise.resolve();
    expect(factory.sockets).toHaveLength(1);
    client.close();
    await expect(connecting).rejects.toBeInstanceOf(HermesGatewayConnectionError);
    expect(client.state).toBe("closed");
  });

  it("marks a status-less indeterminate replay and blocks later mutations", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {}, stableMutationReady);
    const prompt = client.submitPrompt(
      { session_id: "session-1", text: "private" },
      {
        operationId: "prompt-recovery-operation",
        mutationId: "prompt-recovery-mutation",
      },
    );
    const frame = sentFrames(socket).at(-1)!;
    expect(frame.params.mutation_id).toBe("prompt-recovery-mutation");
    socket.receive(
      success(frame.id, {
        mutation_id: "prompt-recovery-mutation",
        mutation_status: "indeterminate",
        run_id: "run-recovery",
        replayed: true,
      }),
    );

    await expect(prompt).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);
    expect(client.mutationRecord("prompt-recovery-operation")?.state).toBe("indeterminate");
    expect(client.writesBlocked).toBe(true);
    await expect(
      client.interrupt("session-1", { operationId: "blocked-interrupt" }),
    ).rejects.toBeInstanceOf(HermesGatewayMutationsBlockedError);
    expect(sentFrames(socket)).toHaveLength(1);
    client.close();
  });

  it.each(["complete", "interrupted", "error"] as const)(
    "accepts and confirms a terminal %s prompt replay",
    async (status) => {
      const factory = new FakeSocketFactory();
      const { client, socket } = await openClient(factory, {}, stableMutationReady);
      const operationId = `prompt-${status}-operation`;
      const prompt = client.submitPrompt(
        { session_id: "session-1", text: "private" },
        {
          operationId,
          mutationId: `prompt-${status}-mutation`,
        },
      );
      const frame = sentFrames(socket).at(-1)!;
      socket.receive(
        success(frame.id, {
          status,
          mutation_id: `prompt-${status}-mutation`,
          mutation_status: "completed",
          run_id: `run-${status}`,
          message_id: `message-${status}`,
        }),
      );

      await expect(prompt).resolves.toMatchObject({
        status,
        mutation_status: "completed",
        run_id: `run-${status}`,
      });
      expect(client.mutationRecord(operationId)?.state).toBe("confirmed");
      expect(client.writesBlocked).toBe(false);
      client.close();
    },
  );

  it("handles indeterminate replays before decoding create, resume, and interrupt results", async () => {
    const cases = [
      {
        operationId: "create-recovery-operation",
        mutationId: "create-recovery-mutation",
        invoke: (client: HermesGatewayClient) =>
          client.createSession(
            { source: "t3-code" },
            {
              operationId: "create-recovery-operation",
              mutationId: "create-recovery-mutation",
            },
          ),
      },
      {
        operationId: "resume-recovery-operation",
        mutationId: "resume-recovery-mutation",
        invoke: (client: HermesGatewayClient) =>
          client.resumeSession(
            { session_id: "stored-session-1" },
            {
              operationId: "resume-recovery-operation",
              mutationId: "resume-recovery-mutation",
            },
          ),
      },
      {
        operationId: "interrupt-recovery-operation",
        mutationId: "interrupt-recovery-mutation",
        invoke: (client: HermesGatewayClient) =>
          client.interrupt("session-1", {
            operationId: "interrupt-recovery-operation",
            mutationId: "interrupt-recovery-mutation",
          }),
      },
    ] as const;

    for (const testCase of cases) {
      const factory = new FakeSocketFactory();
      const { client, socket } = await openClient(factory, {}, stableMutationReady);
      const mutation = testCase.invoke(client);
      const frame = sentFrames(socket).at(-1)!;
      socket.receive(
        success(frame.id, {
          mutation_id: testCase.mutationId,
          mutation_status: "indeterminate",
          run_id: "",
          replayed: true,
        }),
      );

      await expect(mutation).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);
      expect(client.mutationRecord(testCase.operationId)?.state).toBe("indeterminate");
      client.close();
    }
  });

  it("does not confirm an undecodable successful mutation response", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);
    const created = client.createSession(
      { source: "t3-code" },
      { operationId: "malformed-create-operation" },
    );
    const frame = sentFrames(socket).at(-1)!;
    socket.receive(success(frame.id, { unexpected: true }));

    await expect(created).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);
    expect(client.mutationRecord("malformed-create-operation")?.state).toBe("indeterminate");
    expect(client.writesBlocked).toBe(true);
    client.close();
  });

  it("replays reads after bounded reconnect but never replays an indeterminate mutation", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const read = client.read("session.list", {});
    const mutation = client.mutate(
      "prompt.submit",
      { session_id: "session-1", text: "private" },
      { operationId: "prompt-operation" },
    );
    expect(sentFrames(socket).map((frame) => frame.method)).toEqual([
      "session.list",
      "prompt.submit",
    ]);

    socket.close(1006);
    await expect(mutation).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);
    expect(client.writesBlocked).toBe(true);
    await eventually(() => factory.sockets.length === 2);
    const replacement = factory.sockets[1]!;
    replacement.open();
    await Promise.resolve();
    replacement.receive(fullyNegotiatedReady);
    await eventually(() => replacement.sent.length === 1);
    const replayed = sentFrames(replacement);
    expect(replayed.map((frame) => frame.method)).toEqual(["session.list"]);
    replacement.receive(success(replayed[0]!.id, { sessions: [] }));
    await expect(read).resolves.toEqual({ sessions: [] });
    await expect(
      client.mutate(
        "prompt.submit",
        { session_id: "session-1", text: "must not send" },
        { operationId: "prompt-operation-2" },
      ),
    ).rejects.toBeInstanceOf(HermesGatewayMutationsBlockedError);
    expect(replacement.sent).toHaveLength(1);

    client.acknowledgeIndeterminate("prompt-operation");
    const interrupt = client.interrupt("session-1", { operationId: "interrupt-operation" });
    const interruptFrame = sentFrames(replacement)[1]!;
    expect(interruptFrame).toMatchObject({
      method: "session.interrupt",
      params: { session_id: "session-1" },
    });
    replacement.receive(success(interruptFrame.id, { status: "interrupted" }));
    await expect(interrupt).resolves.toEqual({ status: "interrupted" });
    client.close();
  });

  it("bounds reconnect attempts and exposes process supervision hooks", async () => {
    const factory = new FakeSocketFactory();
    const callbacks: string[] = [];
    let exhausted!: () => void;
    const exhaustedPromise = new Promise<void>((resolve) => {
      exhausted = resolve;
    });
    const { socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      supervisor: {
        beforeConnect: ({ attempt, reconnect }) => {
          callbacks.push(`before:${attempt}:${reconnect}`);
        },
        onConnected: ({ attempt }) => {
          callbacks.push(`connected:${attempt}`);
        },
        onDisconnected: ({ reconnecting }) => {
          callbacks.push(`disconnected:${reconnecting}`);
          return Promise.reject(new Error("supervisor disconnect failure"));
        },
        onReconnectExhausted: ({ attempts }) => {
          callbacks.push(`exhausted:${attempts}`);
          exhausted();
          return Promise.reject(new Error("supervisor exhausted failure"));
        },
      },
      socketFactory: (endpoint) => {
        const candidate = factory.create(endpoint);
        if (factory.sockets.length > 1) {
          queueMicrotask(() => candidate.fail());
        }
        return candidate;
      },
    });
    socket.close(1006);
    await exhaustedPromise;

    expect(factory.sockets).toHaveLength(3);
    expect(callbacks).toEqual([
      "before:0:false",
      "connected:0",
      "disconnected:true",
      "before:1:true",
      "disconnected:true",
      "before:2:true",
      "disconnected:true",
      "exhausted:2",
    ]);
  });
});

const skillsReady = {
  jsonrpc: "2.0",
  method: "event",
  params: {
    type: "gateway.ready",
    payload: {
      protocol: {
        major: 1,
        minor: 0,
        capabilities: {
          "skills.manage": "supported",
          "skills.reload": "supported",
        },
      },
    },
  },
} as const;

describe("HermesGatewayClient skills", () => {
  it("uses the skills.manage read and skills.reload mutation wire protocol", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {}, skillsReady);

    const listing = client.listSkills();
    let frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({ method: "skills.manage", params: { action: "list" } });
    socket.receive(success(frame.id, { skills: [{ name: "notes", description: "Take notes" }] }));
    await expect(listing).resolves.toEqual({
      skills: [{ name: "notes", description: "Take notes" }],
    });

    const searching = client.searchSkills("git");
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "skills.manage",
      params: { action: "search", query: "git" },
    });
    socket.receive(success(frame.id, { results: [{ name: "git-helper", description: "Git" }] }));
    await expect(searching).resolves.toEqual({
      results: [{ name: "git-helper", description: "Git" }],
    });

    const inspecting = client.inspectSkill("git-helper");
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "skills.manage",
      params: { action: "inspect", query: "git-helper" },
    });
    socket.receive(success(frame.id, { info: { name: "git-helper" } }));
    await expect(inspecting).resolves.toEqual({ info: { name: "git-helper" } });

    const reloading = client.reloadSkills({ operationId: "skills-reload-1" });
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({ method: "skills.reload", params: {} });
    socket.receive(
      success(frame.id, {
        output: "Reloaded",
        result: { added: [{ name: "new-skill" }], removed: [], total: 4 },
      }),
    );
    await expect(reloading).resolves.toEqual({
      output: "Reloaded",
      result: { added: [{ name: "new-skill" }], removed: [], total: 4 },
    });
    client.close();
  });

  it("removes only the skills.manage capability after a -32601 response", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {}, skillsReady);

    const listing = client.listSkills();
    const frame = sentFrames(socket).at(-1)!;
    socket.receive({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32601, message: "method not found" },
    });
    await expect(listing).rejects.toThrow("skills.manage failed with code -32601");
    expect(client.hasCapability("skills.manage")).toBe(false);
    expect(client.hasCapability("skills.reload")).toBe(true);
    await expect(client.listSkills()).rejects.toBeInstanceOf(HermesGatewayCapabilityError);
    client.close();
  });

  it("refuses skills access on a legacy gateway without a negotiated inventory", async () => {
    const factory = new FakeSocketFactory();
    const { client } = await openClient(factory, {}, legacyReady);
    await expect(client.listSkills()).rejects.toBeInstanceOf(HermesGatewayCapabilityError);
    await expect(client.reloadSkills({ operationId: "skills-reload-2" })).rejects.toBeInstanceOf(
      HermesGatewayCapabilityError,
    );
    client.close();
  });
});

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
