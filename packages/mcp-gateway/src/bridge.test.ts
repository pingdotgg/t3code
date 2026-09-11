// @effect-diagnostics nodeBuiltinImport:off - exercises durable SQLite replay across a real bridge reconnect.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";
import WebSocket from "ws";

import { createBridgeRuntimePort } from "./bridge.ts";
import { createGatewayEventStore } from "./events.ts";
import type { GatewayMutationResult } from "./port.ts";
import { callGatewayTool } from "./tools.ts";

const TOKEN = "test-token-123456789";

function proof(value: string): string {
  return NodeCrypto.createHmac("sha256", TOKEN).update(value).digest("hex");
}

async function unusedPort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", resolve));
}

function authenticate(
  socket: WebSocket,
  onRequest?: (message: Record<string, unknown>) => void,
  configure = true,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let nonce: string | null = null;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "challenge" && typeof message.nonce === "string") {
        nonce = message.nonce;
        socket.send(
          JSON.stringify({ type: "authenticate", proof: proof(`client:${message.nonce}`) }),
        );
        return;
      }
      if (message.type === "authenticated") {
        if (nonce === null || message.proof !== proof(`server:${nonce}`)) {
          reject(new Error("Invalid server proof."));
          return;
        }
        if (configure) {
          socket.send(JSON.stringify({ type: "configure", grants: {} }));
        } else resolve();
        return;
      }
      if (message.type === "configured") resolve();
      onRequest?.(message);
    });
  });
}

describe("gateway bridge", () => {
  it("rejects unauthenticated clients and serves only a mutually authenticated runtime", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 100 });
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}`);
    const challenged = new Promise<void>((resolve) => {
      unauthenticated.once("message", () => {
        unauthenticated.send(JSON.stringify({ type: "authenticate", proof: "wrong" }));
        resolve();
      });
    });
    await opened(unauthenticated);
    await challenged;
    await closed(unauthenticated);
    await expect(bridge.port.listEnvironments()).rejects.toThrow("No configured T3 client");

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client, (message) => {
      if (message.method === "listEnvironments") {
        client.send(JSON.stringify({ id: message.id, result: [{ environmentId: "local" }] }));
      }
    });
    await opened(client);
    await authenticated;

    await expect(bridge.port.listEnvironments()).resolves.toEqual([{ environmentId: "local" }]);
    client.close();
    await bridge.close();
  });

  it("round-trips un-settlement through the authenticated client bridge", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN });
    await bridge.ready;
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const requests: unknown[] = [];
    const authenticated = authenticate(client, (message) => {
      requests.push(message);
      client.send(JSON.stringify({ id: message.id, result: { status: "succeeded" } }));
    });
    await opened(client);
    await authenticated;
    try {
      await expect(bridge.port.unsettleThread!("local", "chat")).resolves.toEqual({
        status: "succeeded",
      });
      expect(requests).toContainEqual(
        expect.objectContaining({ method: "unsettleThread", args: ["local", "chat"] }),
      );
    } finally {
      client.close();
      await bridge.close();
    }
  });

  it("keeps the first bridge alive and reports a typed degraded result when the port is occupied", async () => {
    const port = await unusedPort();
    const first = createBridgeRuntimePort({ port, token: TOKEN });
    await expect(first.ready).resolves.toEqual({ status: "running" });

    const second = createBridgeRuntimePort({ port, token: TOKEN });
    await expect(second.ready).resolves.toMatchObject({
      status: "degraded",
      code: "address_in_use",
      port,
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client, (message) => {
      if (message.method === "listEnvironments") {
        client.send(JSON.stringify({ id: message.id, result: [{ environmentId: "local" }] }));
      }
    });
    await opened(client);
    await authenticated;
    await expect(first.port.listEnvironments()).resolves.toEqual([{ environmentId: "local" }]);

    client.close();
    await second.close();
    await first.close();
  });

  it("does not activate a runtime until it supplies valid grant configuration", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({
      port,
      token: TOKEN,
      initialGrants: { stale: ["read"] },
      requestTimeoutMs: 25,
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const onRequest = vi.fn();
    const authenticated = authenticate(client, onRequest, false);
    await opened(client);
    await authenticated;

    await expect(bridge.port.listEnvironments()).rejects.toThrow("No configured T3 client");
    expect(onRequest).not.toHaveBeenCalled();

    const closedClient = closed(client);
    client.send(JSON.stringify({ type: "configure", grants: { stale: ["unknown-scope"] } }));
    await closedClient;
    await expect(bridge.port.listEnvironments()).rejects.toThrow("No configured T3 client");
    await bridge.close();
  });

  it("rejects configuration from a superseded authenticated connection", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN });
    const older = new WebSocket(`ws://127.0.0.1:${port}`);
    const olderAuthenticated = authenticate(older, undefined, false);
    await opened(older);
    await olderAuthenticated;

    const newer = new WebSocket(`ws://127.0.0.1:${port}`);
    const newerAuthenticated = authenticate(newer, undefined, false);
    await opened(newer);
    await newerAuthenticated;
    newer.send(
      JSON.stringify({
        type: "configure",
        grants: { "a534b83f-a352-44d8-aedc-c4230c179390": ["read"] },
      }),
    );
    await vi.waitFor(() =>
      expect(bridge.getGrants()).toEqual({
        "a534b83f-a352-44d8-aedc-c4230c179390": ["read"],
      }),
    );

    const olderClosed = closed(older);
    older.send(
      JSON.stringify({
        type: "configure",
        grants: { "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read", "send"] },
      }),
    );
    await olderClosed;
    expect(bridge.getGrants()).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read"],
    });

    newer.close();
    await bridge.close();
  });

  it("accepts grant configuration only from the authenticated runtime", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client, undefined, false);
    await opened(client);
    await authenticated;

    client.send(
      JSON.stringify({
        type: "configure",
        grants: {
          "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
          "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
        },
        profiles: [
          {
            name: " Andy ",
            modelSelection: { instanceId: "glm", model: "glm-5.3" },
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        ],
      }),
    );

    await vi.waitFor(() =>
      expect(bridge.getGrants()).toEqual({
        "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
        "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
      }),
    );
    expect(Object.hasOwn(bridge.getGrants(), "constructor")).toBe(false);
    expect(bridge.getGrants()["constructor"]).toBeUndefined();
    expect(bridge.getProfiles()).toEqual([
      {
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ]);
    client.close();
    await bridge.close();
  });

  it("returns durable cursors and ingests events only for granted environments", async () => {
    const port = await unusedPort();
    const onEvent = vi.fn();
    const getEventCursor = vi.fn((environmentId: string) =>
      environmentId === "granted" ? 41 : 99,
    );
    const bridge = createBridgeRuntimePort({
      port,
      token: TOKEN,
      onEvent,
      getEventCursor,
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: Array<Record<string, unknown>> = [];
    const authenticated = authenticate(client, (message) => messages.push(message), false);
    await opened(client);
    await authenticated;
    client.send(JSON.stringify({ type: "configure", grants: { granted: ["read"] } }));

    await vi.waitFor(() =>
      expect(messages).toContainEqual({ type: "configured", cursors: { granted: 41 } }),
    );
    expect(getEventCursor).toHaveBeenCalledTimes(1);
    expect(getEventCursor).toHaveBeenCalledWith("granted");

    client.send(
      JSON.stringify({
        type: "event",
        event: {
          environmentId: "denied",
          eventId: "e-1",
          sequence: 100,
          type: "thread.progress",
          occurredAt: "2026-09-04T00:00:00.000Z",
        },
      }),
    );
    client.send(
      JSON.stringify({
        type: "event",
        event: {
          environmentId: "granted",
          eventId: "e-2",
          sequence: 42,
          type: "thread.progress",
          occurredAt: "2026-09-04T00:00:01.000Z",
        },
      }),
    );
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "granted", eventId: "e-2", sequence: 42 }),
    );

    client.close();
    await bridge.close();
  });

  it.each(["accept", "acceptForSession"] as const)(
    "recovers one authoritative %s side effect after a real bridge disconnect and store reopen",
    async (decision) => {
      const port = await unusedPort();
      const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 100 });
      await bridge.ready;
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-replay-"));
      const file = NodePath.join(directory, "events.sqlite");
      let events = createGatewayEventStore({ file });
      let pending = true;
      let sideEffects = 0;
      const receipts = new Map<string, GatewayMutationResult>();
      const thread = () => ({
        id: "thread-1",
        activities: pending
          ? [
              {
                id: "approval-1",
                sequence: 1,
                kind: "approval.requested",
                payload: {
                  requestId: "approval-1",
                  requestKind: "command",
                  detail: "Run command",
                },
              },
            ]
          : [
              {
                id: "approval-1",
                sequence: 1,
                kind: "approval.requested",
                payload: {
                  requestId: "approval-1",
                  requestKind: "command",
                  detail: "Run command",
                },
              },
              {
                id: "approval-resolved-1",
                sequence: 2,
                kind: "approval.resolved",
                payload: { requestId: "approval-1" },
              },
            ],
      });
      let disconnectAfterAcceptance = true;
      const connectRuntime = async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        const authenticated = authenticate(
          socket,
          (message) => {
            const id = message.id;
            const args = message.args as ReadonlyArray<Record<string, unknown>> | undefined;
            if (message.method === "getThread") {
              socket.send(JSON.stringify({ id, result: thread() }));
              return;
            }
            if (message.method !== "respondToApproval") return;
            const request = args?.[0];
            const requestId = String(request?.requestId ?? "");
            const previous = receipts.get(requestId);
            if (previous !== undefined) {
              socket.send(JSON.stringify({ id, result: previous }));
              return;
            }
            sideEffects += 1;
            pending = false;
            const receipt = {
              requestId,
              commandId: requestId,
              status: "accepted" as const,
              threadId: String(request?.threadId ?? ""),
            };
            receipts.set(requestId, receipt);
            if (disconnectAfterAcceptance) socket.close(1012, "injected response loss");
            else socket.send(JSON.stringify({ id, result: receipt }));
          },
          false,
        );
        await opened(socket);
        await authenticated;
        socket.send(JSON.stringify({ type: "configure", grants: { local: ["read", "approval"] } }));
        await vi.waitFor(() => expect(bridge.getHealth().bridge).toBe("connected"));
        expect(bridge.getGrants()).toEqual({ local: ["read", "approval"] });
        return socket;
      };
      let runtime = await connectRuntime();
      const request = {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision,
        confirmDestructive: true,
        idempotencyKey: `bridge-lost-${decision}`,
      };
      try {
        await expect(
          callGatewayTool(
            { port: bridge.port, grants: bridge.getGrants, events },
            "t3_respond_to_approval",
            request,
          ),
        ).rejects.toThrow("disconnected");
        events.close();
        events = createGatewayEventStore({ file });
        disconnectAfterAcceptance = false;
        runtime = await connectRuntime();

        await expect(
          callGatewayTool(
            { port: bridge.port, grants: bridge.getGrants, events },
            "t3_respond_to_approval",
            request,
          ),
        ).resolves.toEqual([...receipts.values()][0]);
        expect(sideEffects).toBe(1);
      } finally {
        runtime.close();
        events.close();
        await bridge.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("recovers an interrupted historical send using complete message evidence after bridge reconnect", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 100 });
    await bridge.ready;
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-send-replay-"));
    const file = NodePath.join(directory, "events.sqlite");
    const input = {
      environmentId: "local",
      threadId: "thread-1",
      text: "Persisted outside the bounded projection",
      idempotencyKey: "historical-send",
    };
    const key = "local::thread-1::mcp-request-historical-send";
    const requestId = `mcp-request-v2-${NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          aggregateId: "thread-1",
          environmentId: "local",
          idempotencyKey: "historical-send",
          version: 2,
        }),
      )
      .digest("hex")}`;
    const receipt = {
      requestId,
      commandId: requestId,
      status: "accepted" as const,
      threadId: "thread-1",
      messageId: "mcp-message-historical-send",
    };
    let events = createGatewayEventStore({ file });
    events.rememberRequest(
      key,
      `{"input":{"environmentId":"local","idempotencyKey":"historical-send","text":"Persisted outside the bounded projection","threadId":"thread-1"},"operation":"message.send"}`,
      null,
    );
    events.markRequestDispatched(key, {
      requestId,
      messageId: receipt.messageId,
    });
    events.close();
    events = createGatewayEventStore({ file });
    const methods: string[] = [];
    const runtime = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(
      runtime,
      (message) => {
        if (typeof message.method !== "string") return;
        methods.push(message.method);
        const id = message.id;
        if (message.method === "hasThreadMessage") {
          runtime.send(JSON.stringify({ id, result: true }));
        } else if (message.method === "sendMessage") {
          runtime.send(JSON.stringify({ id, result: receipt }));
        }
      },
      false,
    );
    try {
      await opened(runtime);
      await authenticated;
      runtime.send(JSON.stringify({ type: "configure", grants: { local: ["read", "send"] } }));
      await vi.waitFor(() => expect(bridge.getHealth().bridge).toBe("connected"));

      await expect(
        callGatewayTool(
          { port: bridge.port, grants: bridge.getGrants, events },
          "t3_send_message",
          input,
        ),
      ).resolves.toEqual(receipt);
      expect(methods).toEqual(["hasThreadMessage", "sendMessage"]);

      events.close();
      events = createGatewayEventStore({ file });
      await expect(
        callGatewayTool(
          { port: bridge.port, grants: bridge.getGrants, events },
          "t3_send_message",
          input,
        ),
      ).resolves.toEqual(receipt);
      expect(methods).toEqual(["hasThreadMessage", "sendMessage", "hasThreadMessage"]);
    } finally {
      runtime.close();
      events.close();
      await bridge.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["t3_reject_actions", "t3_approve_actions"],
    ["t3_approve_actions", "t3_reject_actions"],
  ] as const)(
    "rejects %s to %s identity changes after a real bridge disconnect and store reopen",
    async (firstTool, oppositeTool) => {
      const port = await unusedPort();
      const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 100 });
      await bridge.ready;
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-identity-"));
      const file = NodePath.join(directory, "events.sqlite");
      let events = createGatewayEventStore({ file });
      const received: Array<Record<string, unknown>> = [];
      const thread = {
        id: "thread-1",
        activities: [
          {
            id: "approval-1",
            sequence: 1,
            kind: "approval.requested",
            payload: { requestId: "approval-1", requestKind: "command", detail: "Run command" },
          },
        ],
      };
      let disconnectBeforeAcceptance = true;
      const connectRuntime = async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        const authenticated = authenticate(
          socket,
          (message) => {
            const id = message.id;
            const args = message.args as ReadonlyArray<Record<string, unknown>> | undefined;
            if (message.method === "getThread") {
              socket.send(JSON.stringify({ id, result: thread }));
              return;
            }
            if (message.method !== "respondToApprovals") return;
            received.push(args?.[0] ?? {});
            if (disconnectBeforeAcceptance) {
              socket.close(1012, "injected pre-acceptance disconnect");
              return;
            }
            socket.send(
              JSON.stringify({
                id,
                result: {
                  requestId: String(args?.[0]?.requestId ?? ""),
                  commandId: String(args?.[0]?.requestId ?? ""),
                  status: "accepted",
                  threadId: "thread-1",
                },
              }),
            );
          },
          false,
        );
        await opened(socket);
        await authenticated;
        socket.send(JSON.stringify({ type: "configure", grants: { local: ["read", "approval"] } }));
        await vi.waitFor(() => expect(bridge.getHealth().bridge).toBe("connected"));
        return socket;
      };
      let runtime = await connectRuntime();
      const request = {
        environmentId: "local",
        threadId: "thread-1",
        actionIds: ["approval-1"],
        planRevision: 1,
        ...(firstTool === "t3_approve_actions" ? { confirmDestructive: true } : {}),
        idempotencyKey: `bridge-opposite-${firstTool}`,
      };
      try {
        await expect(
          callGatewayTool(
            { port: bridge.port, grants: bridge.getGrants, events },
            firstTool,
            request,
          ),
        ).rejects.toThrow("disconnected");
        events.close();
        events = createGatewayEventStore({ file });
        disconnectBeforeAcceptance = false;
        runtime = await connectRuntime();

        await expect(
          callGatewayTool(
            { port: bridge.port, grants: bridge.getGrants, events },
            oppositeTool,
            request,
          ),
        ).rejects.toMatchObject({ code: "idempotency_conflict" });
        await expect(
          callGatewayTool(
            { port: bridge.port, grants: bridge.getGrants, events },
            "t3_approve_actions",
            {
              ...request,
              confirmDestructive: undefined,
              idempotencyKey: `${request.idempotencyKey}-fresh`,
            },
          ),
        ).rejects.toMatchObject({ code: "destructive_confirmation_required" });
        expect(received).toHaveLength(1);
        expect(received[0]?.requestId).toMatch(/^mcp-approval-plan-v2-/u);
      } finally {
        runtime.close();
        events.close();
        await bridge.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("uses distinct authoritative command IDs across grouped and legacy approval namespaces", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 100 });
    await bridge.ready;
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-namespace-"));
    const file = NodePath.join(directory, "events.sqlite");
    let events = createGatewayEventStore({ file });
    const received: Array<Record<string, unknown>> = [];
    const thread = {
      id: "thread-1",
      activities: [
        {
          id: "approval-1",
          sequence: 1,
          kind: "approval.requested",
          payload: { requestId: "approval-1", requestKind: "command", detail: "First command" },
        },
        {
          id: "approval-2",
          sequence: 2,
          kind: "approval.requested",
          payload: { requestId: "approval-2", requestKind: "command", detail: "Second command" },
        },
      ],
    };
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(socket, (message) => {
      const id = message.id;
      const args = message.args as ReadonlyArray<Record<string, unknown>> | undefined;
      if (message.method === "getThread") {
        socket.send(JSON.stringify({ id, result: thread }));
        return;
      }
      if (message.method !== "respondToApprovals" && message.method !== "respondToApproval") return;
      const request = args?.[0] ?? {};
      received.push({ method: message.method, ...request });
      socket.send(
        JSON.stringify({
          id,
          result: {
            requestId: String(request.requestId ?? ""),
            commandId: String(request.requestId ?? ""),
            status: "accepted",
            threadId: "thread-1",
          },
        }),
      );
    });
    await opened(socket);
    await authenticated;
    socket.send(JSON.stringify({ type: "configure", grants: { local: ["read", "approval"] } }));
    await vi.waitFor(() => expect(bridge.getGrants()).toEqual({ local: ["read", "approval"] }));

    const idempotencyKey = "cross-approval-namespace";
    try {
      await callGatewayTool(
        { port: bridge.port, grants: bridge.getGrants, events },
        "t3_reject_actions",
        {
          environmentId: "local",
          threadId: "thread-1",
          actionIds: ["approval-1"],
          planRevision: 2,
          idempotencyKey,
        },
      );
      events.close();
      events = createGatewayEventStore({ file });
      await callGatewayTool(
        { port: bridge.port, grants: bridge.getGrants, events },
        "t3_respond_to_approval",
        {
          environmentId: "local",
          threadId: "thread-1",
          approvalRequestId: "approval-2",
          decision: "accept",
          confirmDestructive: true,
          idempotencyKey,
        },
      );

      expect(received).toHaveLength(2);
      expect(received[0]?.requestId).toMatch(/^mcp-approval-plan-v2-/u);
      expect(received[1]?.requestId).toMatch(/^mcp-approval-response-v2-/u);
      expect(received[0]?.requestId).not.toBe(received[1]?.requestId);
    } finally {
      socket.close();
      events.close();
      await bridge.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("filters authenticated status snapshots, applies revocation, and keeps old clients quiet", async () => {
    const port = await unusedPort();
    const events = createGatewayEventStore({ file: ":memory:", allowPrivateWebhookTargets: true });
    events.registerWebhook({
      environmentId: "current",
      url: "http://127.0.0.1/hook?secret=hidden",
    });
    events.emit({ environmentId: "current", type: "thread.started" });
    events.emit({ environmentId: "other", type: "thread.started" });
    const bridge = createBridgeRuntimePort({
      port,
      token: TOKEN,
      getStatusSnapshot: events.statusSnapshot,
      onStatusChange: events.onStatusChange,
    });
    const messages: Array<Record<string, unknown>> = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client, (message) => messages.push(message), false);
    await opened(client);
    await authenticated;
    client.send(
      JSON.stringify({
        type: "configure",
        grants: { current: ["read"], other: ["delivery"] },
        capabilities: { statusSnapshots: true },
      }),
    );
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "status.snapshot")).toBe(true),
    );
    const initial = messages.find((message) => message.type === "status.snapshot") as {
      snapshot: { environments: Array<Record<string, unknown>> };
    };
    expect(initial.snapshot.environments).toHaveLength(1);
    expect(initial.snapshot.environments[0]).toMatchObject({
      environmentId: "current",
      deliveryAccess: false,
    });
    expect(initial.snapshot.environments[0]).not.toHaveProperty("webhooks");
    expect(JSON.stringify(initial)).not.toContain("secret=hidden");
    messages.length = 0;
    client.send(JSON.stringify({ type: "status.request", requestId: "refresh-1" }));
    await vi.waitFor(() =>
      expect(messages.some((message) => message.requestId === "refresh-1")).toBe(true),
    );

    messages.length = 0;
    client.send(
      JSON.stringify({
        type: "configure",
        grants: { current: ["read", "delivery"] },
        capabilities: { statusSnapshots: true },
      }),
    );
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "status.snapshot")).toBe(true),
    );
    expect(JSON.stringify(messages)).toContain("webhookCount");
    messages.length = 0;
    events.subscribe({ environmentId: "current" });
    events.subscribe({ environmentId: "current" });
    await vi.waitFor(() =>
      expect(messages.filter((message) => message.type === "status.snapshot")).toHaveLength(1),
    );
    expect(JSON.stringify(messages)).toContain('"subscriptionCount":2');
    messages.length = 0;
    client.send(
      JSON.stringify({
        type: "configure",
        grants: { current: ["read"] },
        capabilities: { statusSnapshots: true },
      }),
    );
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "status.snapshot")).toBe(true),
    );
    expect(JSON.stringify(messages)).not.toContain("webhookCount");
    client.close();

    const oldMessages: Array<Record<string, unknown>> = [];
    const oldClient = new WebSocket(`ws://127.0.0.1:${port}`);
    const oldAuthenticated = authenticate(oldClient, (message) => oldMessages.push(message), false);
    await opened(oldClient);
    await oldAuthenticated;
    oldClient.send(JSON.stringify({ type: "configure", grants: { current: ["read"] } }));
    await vi.waitFor(() =>
      expect(oldMessages.some((message) => message.type === "configured")).toBe(true),
    );
    events.emit({ environmentId: "current", type: "thread.completed" });
    await Promise.resolve();
    expect(oldMessages.some((message) => message.type === "status.snapshot")).toBe(false);
    oldClient.close();
    events.close();
    await bridge.close();
  });

  it("refuses status requests before authentication", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const challenged = new Promise<void>((resolve) => client.once("message", () => resolve()));
    await opened(client);
    await challenged;
    const didClose = closed(client);
    client.send(JSON.stringify({ type: "status.request", requestId: "preauth" }));
    await didClose;
    await bridge.close();
  });

  it("times out requests that receive no runtime response", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 10 });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client);
    await opened(client);
    await authenticated;

    await expect(bridge.port.listEnvironments()).rejects.toThrow("timed out");
    client.close();
    await bridge.close();
  });
});
