import { describe, expect, it, vi } from "@effect/vitest";

import { GatewayError, type GatewayRuntimePort } from "./port.ts";
import { callGatewayTool } from "./tools.ts";

function makePort(): GatewayRuntimePort {
  const environments = ["local", "remote"] as const;
  const threads = new Map<string, Array<Record<string, unknown>>>(
    environments.map((environmentId) => [environmentId, []]),
  );
  return {
    listEnvironments: async () =>
      environments.map((environmentId) => ({
        environmentId,
        label: environmentId,
        targetKind: environmentId === "local" ? "primary" : "relay",
        connectionState: "connected",
      })),
    getEnvironmentStatus: async (environmentId) => ({
      environmentId,
      connectionState: "connected",
    }),
    listProjects: async (environmentId) => ({
      snapshotAt: "2026-09-02T00:00:00.000Z",
      items: [{ id: `${environmentId}-project`, title: "Project", workspaceRoot: "/repo" }],
    }),
    listThreads: async (environmentId) => ({
      snapshotAt: "2026-09-02T00:00:00.000Z",
      items: threads.get(environmentId) ?? [],
    }),
    getThread: async (environmentId, threadId) => ({
      id: threadId,
      environmentId,
      messages: [{ id: "message-1", role: "assistant", text: `hello from ${environmentId}` }],
    }),
    createThread: async (input) => {
      const thread = { id: input.threadId, projectId: input.projectId, title: input.title };
      threads.get(input.environmentId)?.push(thread);
      return {
        requestId: input.requestId,
        commandId: input.requestId,
        status: "accepted",
        threadId: input.threadId,
      };
    },
    sendMessage: async (input) => ({
      requestId: input.requestId,
      commandId: input.requestId,
      status: "accepted",
      threadId: input.threadId,
      messageId: input.messageId,
    }),
  };
}

const grants = {
  local: ["read", "create", "send"],
  remote: ["read", "create", "send"],
} as const;

const profiles = [
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
] as const;

describe("gateway chat tools", () => {
  it.each(["local", "remote"])("reads, creates, and sends chats in %s", async (environmentId) => {
    const port = makePort();
    const context = { port, grants, profiles };

    const listed = await callGatewayTool(context, "t3_list_threads", { environmentId });
    expect(listed).toMatchObject({ items: [] });

    const created = await callGatewayTool(context, "t3_create_thread", {
      environmentId,
      projectId: `${environmentId}-project`,
      title: "Gateway chat",
      ...(environmentId === "local"
        ? { profile: "Andy" }
        : { modelSelection: { instanceId: "codex", model: "gpt-5" } }),
      idempotencyKey: `${environmentId}-create-1`,
    });
    expect(created).toMatchObject({ status: "accepted" });

    const sent = await callGatewayTool(context, "t3_send_message", {
      environmentId,
      threadId: created.threadId,
      text: "Run the checks",
      idempotencyKey: `${environmentId}-send-1`,
    });
    expect(sent).toMatchObject({ status: "accepted", threadId: created.threadId });

    const read = await callGatewayTool(context, "t3_get_messages", {
      environmentId,
      threadId: created.threadId,
    });
    expect(read.items[0]).toMatchObject({ text: `hello from ${environmentId}` });
  });

  it("lists readable profiles without exposing provider or model routing ids", async () => {
    const listed = await callGatewayTool(
      { port: makePort(), grants, profiles },
      "t3_list_profiles",
      {},
    );

    expect(listed).toEqual({
      items: [
        {
          name: "Andy",
          environmentId: "local",
          description: "Andy = OpenCode · GLM 5.3 · medium · full access",
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("opencode");
    expect(JSON.stringify(listed)).not.toContain("glm-5.3");
  });

  it("does not list a profile after its machine create grant is revoked", async () => {
    const listed = await callGatewayTool(
      { port: makePort(), grants: { local: ["read"] }, profiles },
      "t3_list_profiles",
      {},
    );

    expect(listed).toEqual({ items: [] });
  });

  it("creates a thread from a named readable profile", async () => {
    const port = makePort();
    const createThread = vi.spyOn(port, "createThread");

    await callGatewayTool({ port, grants, profiles }, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Gateway chat",
      profile: "Andy",
      idempotencyKey: "profile-create",
    });

    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          instanceId: "opencode",
          model: "glm-5.3",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );
  });

  it("rejects profiles bound to a different machine", async () => {
    await expect(
      callGatewayTool({ port: makePort(), grants, profiles }, "t3_create_thread", {
        environmentId: "remote",
        projectId: "remote-project",
        title: "Wrong machine",
        profile: "Andy",
        idempotencyKey: "wrong-machine",
      }),
    ).rejects.toMatchObject({ code: "invalid_profile", environmentId: "remote" });
  });

  it("rejects a mutation when the host has only read scope", async () => {
    await expect(
      callGatewayTool({ port: makePort(), grants: { local: ["read"] } }, "t3_send_message", {
        environmentId: "local",
        threadId: "thread-1",
        text: "no",
        idempotencyKey: "send-1",
      }),
    ).rejects.toMatchObject({ code: "scope_required", environmentId: "local" });
  });

  it("namespaces command ids when create and send reuse an idempotency key", async () => {
    const port = makePort();
    const createThread = vi.spyOn(port, "createThread");
    const sendMessage = vi.spyOn(port, "sendMessage");
    const context = { port, grants };

    const created = await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Gateway chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: "shared-key",
    });
    await callGatewayTool(context, "t3_send_message", {
      environmentId: "local",
      threadId: created.threadId,
      text: "Run the checks",
      idempotencyKey: "shared-key",
    });

    expect(createThread.mock.calls[0]?.[0].requestId).toBe("mcp-create-thread-shared-key");
    expect(sendMessage.mock.calls[0]?.[0].requestId).toBe("mcp-send-message-shared-key");
  });

  it("rejects unknown environments before invoking the runtime", async () => {
    await expect(
      callGatewayTool({ port: makePort(), grants }, "t3_list_threads", {
        environmentId: "missing",
      }),
    ).rejects.toEqual(
      new GatewayError({
        code: "unknown_environment",
        message: "Environment missing is not granted to this host.",
        retryable: false,
        environmentId: "missing",
      }),
    );
  });
});
