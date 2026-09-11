import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@effect/vitest";

import { createGatewayEventStore } from "./events.ts";
import type { GatewayRuntimePort, GatewayScope } from "./port.ts";
import { createMcpGateway } from "./server.ts";

const port: GatewayRuntimePort = {
  openThread: async (environmentId, threadId) => ({ environmentId, threadId, status: "succeeded" }),
  listEnvironments: async () => [
    { environmentId: "local", label: "Local", targetKind: "primary", connectionState: "connected" },
  ],
  getEnvironmentStatus: async (environmentId) => ({ environmentId, connectionState: "connected" }),
  listProjects: async () => ({ items: [], snapshotAt: "snapshot-1" }),
  listThreads: async () => ({ items: [], snapshotAt: "snapshot-1" }),
  getThread: async (environmentId, threadId) => ({ environmentId, id: threadId, messages: [] }),
  createAssetUrl: async () => ({ relativeUrl: "/asset", expiresAt: 1_800_000_000_000 }),
  getPullRequest: async () => ({}),
  getPullRequestActivity: async () => ({}),
  createThread: async (input) => ({
    requestId: input.requestId,
    commandId: input.requestId,
    status: "accepted",
    threadId: input.threadId,
  }),
  sendMessage: async (input) => ({
    requestId: input.requestId,
    commandId: input.requestId,
    status: "accepted",
    threadId: input.threadId,
    messageId: input.messageId,
  }),
  controlThread: async (input) => ({
    requestId: input.requestId,
    commandId: input.requestId,
    status: "accepted",
    threadId: input.threadId,
  }),
  respondToApproval: async (input) => ({
    requestId: input.requestId,
    commandId: input.requestId,
    status: "accepted",
    threadId: input.threadId,
  }),
};

describe("MCP gateway server", () => {
  it.each([
    ["pause", "control"],
    ["stop", "control"],
    ["pause", "lifecycle"],
    ["stop", "lifecycle"],
  ] as const)(
    "requires an explicit grant for the %s alias and accepts %s scope",
    async (action, scope) => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      let scopes: ReadonlyArray<GatewayScope> = ["read", "create", "send"];
      const controls: Array<unknown> = [];
      const gateway = createMcpGateway({
        port: {
          ...port,
          controlThread: async (input) => {
            controls.push(input);
            return port.controlThread(input);
          },
        },
        grants: () => ({ local: scopes }),
      });
      const client = new Client({ name: "control-regression", version: "1" });
      await gateway.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const request = {
          name: `t3_${action}_thread`,
          arguments: {
            environmentId: "local",
            threadId: "audit",
            idempotencyKey: `grant-${action}`,
          },
        };
        const denied = await client.callTool(request);
        expect(denied.isError).toBe(true);
        expect(denied.structuredContent).toMatchObject({
          error: {
            code: "scope_required",
            message: expect.stringContaining("Settings → MCP Gateway"),
            details: {
              scopeRequirement: "any",
              requiredScopes: ["control", "lifecycle"],
              grantedScopes: scopes,
            },
          },
        });
        expect(controls).toHaveLength(0);
        scopes = [...scopes, scope];
        expect((await client.callTool(request)).structuredContent).toMatchObject({
          data: { status: "accepted", threadId: "audit" },
        });
        expect(controls).toHaveLength(1);
        scopes = ["read", "create", "send"];
        expect((await client.callTool(request)).isError).toBe(true);
        expect(controls).toHaveLength(1);
      } finally {
        await client.close();
        await gateway.server.close();
      }
    },
  );

  it("serves structured tools over an MCP transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const gateway = createMcpGateway({
      port: {
        ...port,
        listProfiles: async () => [
          {
            profileId: "code",
            name: "Code",
            systemPrompt: "Implement the approved plan.",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        ],
      },
      grants: { local: ["read", "create", "send"] },
      profiles: [
        {
          name: "Andy",
          environmentIds: ["local"],
          providerLabel: "OpenCode",
          modelLabel: "GLM 5.3",
          modelSelection: { instanceId: "opencode", model: "glm-5.3" },
          reasoningEffort: "medium",
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      ],
    });
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    await gateway.connect(serverTransport);
    await client.connect(clientTransport);

    const listedTools = await client.listTools();
    const toolNames = listedTools.tools.map((tool) => tool.name);
    expect(toolNames).toHaveLength(58);
    const agents = await client.callTool({
      name: "t3_list_agents",
      arguments: { environmentId: "local" },
    });
    expect(agents.isError).not.toBe(true);
    expect(agents.structuredContent).toMatchObject({
      data: {
        items: [{ profileId: "code", systemPrompt: "Implement the approved plan." }],
      },
    });
    expect(toolNames.some((name) => /^t3_(list|create|update|delete)_profiles?$/.test(name))).toBe(
      false,
    );
    const removed = await client.callTool({
      name: "t3_list_profiles",
      arguments: { environmentId: "local" },
    });
    expect(removed.isError).toBe(true);

    expect(toolNames).toContain("t3_list_threads");
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "t3_summarize_thread",
        "t3_create_agent",
        "t3_update_agent",
        "t3_delete_agent",
        "t3_list_agents",
        "t3_unsettle_thread",
        "t3_open_agents",
        "t3_get_artifact",
        "t3_get_approval_plan",
        "t3_approve_actions",
        "t3_reject_actions",
        "t3_rotate_webhook_secret",
        "t3_get_pr",
        "t3_get_pr_checks",
        "t3_list_review_comments",
      ]),
    );
    const result = await client.callTool({
      name: "t3_list_threads",
      arguments: { environmentId: "local" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: "3",
      data: { items: [], snapshotAt: "snapshot-1" },
      warnings: [],
    });

    await client.close();
    await gateway.server.close();
  });

  it("applies grant changes after the MCP server is already connected", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let grants: Readonly<Record<string, ReadonlyArray<"read" | "create" | "send">>> = {};
    const gateway = createMcpGateway({ port, grants: () => grants });
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    await gateway.connect(serverTransport);
    await client.connect(clientTransport);

    const before = await client.callTool({ name: "t3_list_environments", arguments: {} });
    expect(before.structuredContent).toMatchObject({
      schemaVersion: "3",
      data: { items: [], snapshotAt: "runtime" },
    });

    grants = { local: ["read", "create", "send"] };
    const after = await client.callTool({ name: "t3_list_environments", arguments: {} });
    expect(after.structuredContent).toMatchObject({
      schemaVersion: "3",
      data: {
        items: [
          {
            environmentId: "local",
            label: "Local",
            targetKind: "primary",
            connectionState: "connected",
          },
        ],
        snapshotAt: "runtime",
      },
    });

    await client.close();
    await gateway.server.close();
  });

  it("returns structured authorization errors over MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const gateway = createMcpGateway({ port, grants: { local: ["read"] } });
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    await gateway.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "t3_send_message",
      arguments: {
        environmentId: "local",
        threadId: "thread-1",
        text: "hello",
        idempotencyKey: "send-1",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: "3",
      error: {
        code: "scope_required",
        message: "Scope send is required for environment local.",
        retryable: false,
        environmentId: "local",
        requestId: "send-1",
        details: { requiredScopes: ["send"], missingScopes: ["send"] },
      },
    });

    await client.close();
    await gateway.server.close();
  });

  it("pushes durable subscription events over the connected MCP transport", async () => {
    const events = createGatewayEventStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let currentGrants: Record<string, ReadonlyArray<GatewayScope>> = { local: ["read"] };
    const gateway = createMcpGateway({ port, grants: () => currentGrants, events });
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    const notifications: unknown[] = [];
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === "notifications/t3/events")
        notifications.push(notification.params);
    };
    await gateway.connect(serverTransport);
    await client.connect(clientTransport);
    events.emit({ environmentId: "local", type: "thread.progress", threadId: "thread-1" });
    events.emit({ environmentId: "local", type: "thread.started", threadId: "thread-1" });

    const subscribed = await client.callTool({
      name: "t3_subscribe_events",
      arguments: { environmentId: "local", afterSequence: 0, types: ["thread.started"] },
    });
    const subscriptionId = (subscribed.structuredContent as { data: { subscriptionId: string } })
      .data.subscriptionId;
    events.emit({ environmentId: "local", type: "thread.started", threadId: "thread-1" });

    await expect.poll(() => notifications).toHaveLength(2);
    expect(notifications).toEqual([
      expect.objectContaining({
        subscriptionId,
        event: expect.objectContaining({
          environmentId: "local",
          sequence: 2,
          type: "thread.started",
        }),
      }),
      expect.objectContaining({
        subscriptionId,
        event: expect.objectContaining({
          environmentId: "local",
          sequence: 3,
          type: "thread.started",
        }),
      }),
    ]);
    await client.callTool({
      name: "t3_ack_events",
      arguments: { environmentId: "local", subscriptionId, throughSequence: 3 },
    });
    const replay = await client.callTool({
      name: "t3_replay_events",
      arguments: { environmentId: "local", subscriptionId },
    });
    expect(replay.structuredContent).toMatchObject({
      schemaVersion: "3",
      data: { subscriptionId, items: [], ackedSequence: 3 },
    });

    currentGrants = {};
    events.emit({ environmentId: "local", type: "thread.started", threadId: "thread-1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications).toHaveLength(2);

    currentGrants = { local: ["read"] };
    events.emit({ environmentId: "local", type: "thread.started", threadId: "thread-1" });
    await expect.poll(() => notifications).toHaveLength(3);
    expect(notifications.slice(2)).toEqual([
      expect.objectContaining({
        subscriptionId,
        event: expect.objectContaining({ sequence: 5, type: "thread.started" }),
      }),
    ]);
    const revokedReplay = await client.callTool({
      name: "t3_replay_events",
      arguments: { environmentId: "local", subscriptionId },
    });
    expect(revokedReplay.structuredContent).toMatchObject({
      schemaVersion: "3",
      data: {
        subscriptionId,
        items: [expect.objectContaining({ sequence: 5, type: "thread.started" })],
        ackedSequence: 4,
      },
    });

    await client.close();
    await gateway.server.close();
    events.close();
  });

  it("replays and resumes a durable subscription after MCP reconnect", async () => {
    const events = createGatewayEventStore();
    const connect = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const gateway = createMcpGateway({ port, grants: { local: ["read"] }, events });
      const client = new Client({ name: "gateway-test", version: "1.0.0" });
      const notifications: unknown[] = [];
      client.fallbackNotificationHandler = async (notification) => {
        if (notification.method === "notifications/t3/events")
          notifications.push(notification.params);
      };
      await gateway.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, gateway, notifications };
    };

    const first = await connect();
    const subscribed = await first.client.callTool({
      name: "t3_subscribe_events",
      arguments: { environmentId: "local", afterSequence: 0 },
    });
    const subscriptionId = (subscribed.structuredContent as { data: { subscriptionId: string } })
      .data.subscriptionId;
    events.emit({ environmentId: "local", type: "thread.started", threadId: "thread-1" });
    await expect.poll(() => first.notifications).toHaveLength(1);
    await first.client.callTool({
      name: "t3_ack_events",
      arguments: { environmentId: "local", subscriptionId, throughSequence: 1 },
    });
    await first.client.close();
    await first.gateway.close();

    events.emit({ environmentId: "local", type: "thread.progress", threadId: "thread-1" });
    const second = await connect();
    await second.client.callTool({
      name: "t3_replay_events",
      arguments: { environmentId: "local", subscriptionId },
    });
    events.emit({ environmentId: "local", type: "thread.completed", threadId: "thread-1" });

    await expect.poll(() => second.notifications).toHaveLength(2);
    expect(second.notifications).toEqual([
      expect.objectContaining({
        subscriptionId,
        event: expect.objectContaining({ sequence: 2, type: "thread.progress" }),
      }),
      expect.objectContaining({
        subscriptionId,
        event: expect.objectContaining({ sequence: 3, type: "thread.completed" }),
      }),
    ]);

    await second.client.close();
    await second.gateway.close();
    events.close();
  });
});
