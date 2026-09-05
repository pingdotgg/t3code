import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@effect/vitest";

import type { GatewayRuntimePort } from "./port.ts";
import { createMcpGateway } from "./server.ts";

const port: GatewayRuntimePort = {
  listEnvironments: async () => [
    { environmentId: "local", label: "Local", targetKind: "primary", connectionState: "connected" },
  ],
  getEnvironmentStatus: async (environmentId) => ({ environmentId, connectionState: "connected" }),
  listProjects: async () => ({ items: [], snapshotAt: "snapshot-1" }),
  listThreads: async () => ({ items: [], snapshotAt: "snapshot-1" }),
  getThread: async (environmentId, threadId) => ({ environmentId, id: threadId, messages: [] }),
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
};

describe("MCP gateway server", () => {
  it("serves structured tools over an MCP transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const gateway = createMcpGateway({
      port,
      grants: { local: ["read", "create", "send"] },
      profiles: [
        {
          name: "Andy",
          environmentId: "local",
          providerLabel: "OpenCode",
          modelLabel: "GLM 5.3",
          instanceId: "opencode",
          model: "glm-5.3",
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
    expect(listedTools.tools.map((tool) => tool.name)).toContain("t3_list_threads");
    expect(listedTools.tools.map((tool) => tool.name)).toContain("t3_list_profiles");
    const createTool = listedTools.tools.find((tool) => tool.name === "t3_create_thread");
    expect(createTool?.inputSchema).toMatchObject({
      properties: { profile: { type: "string" } },
      required: expect.arrayContaining(["profile"]),
    });
    expect(createTool?.inputSchema).not.toHaveProperty("properties.modelSelection");
    const profiles = await client.callTool({ name: "t3_list_profiles", arguments: {} });
    expect(profiles.structuredContent).toEqual({
      items: [
        {
          name: "Andy",
          environmentId: "local",
          description: "Andy = OpenCode · GLM 5.3 · medium · full access",
        },
      ],
    });
    const result = await client.callTool({
      name: "t3_list_threads",
      arguments: { environmentId: "local" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ items: [], snapshotAt: "snapshot-1" });

    await client.close();
    await gateway.close();
  });

  it("applies grant changes after the MCP server is already connected", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let grants: Readonly<Record<string, ReadonlyArray<"read" | "create" | "send">>> = {};
    const gateway = createMcpGateway({ port, grants: () => grants });
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    await gateway.connect(serverTransport);
    await client.connect(clientTransport);

    const before = await client.callTool({ name: "t3_list_environments", arguments: {} });
    expect(before.structuredContent).toEqual({ items: [], snapshotAt: "runtime" });

    grants = { local: ["read", "create", "send"] };
    const after = await client.callTool({ name: "t3_list_environments", arguments: {} });
    expect(after.structuredContent).toEqual({
      items: [
        {
          environmentId: "local",
          label: "Local",
          targetKind: "primary",
          connectionState: "connected",
        },
      ],
      snapshotAt: "runtime",
    });

    await client.close();
    await gateway.close();
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
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          code: "scope_required",
          message: "Scope send is required for environment local.",
          retryable: false,
          environmentId: "local",
          requestId: undefined,
          details: { requiredScope: "send" },
        }),
      },
    ]);

    await client.close();
    await gateway.close();
  });
});
