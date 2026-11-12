// @effect-diagnostics nodeBuiltinImport:off - exercises durable SQLite replay across a real store reopen.
import { describe, expect, it, vi } from "@effect/vitest";

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createGatewayEventStore } from "./events.ts";
import {
  GatewayError,
  type GatewayMutationResult,
  type GatewayProfile,
  type GatewayRuntimePort,
  type GatewayThreadControlAction,
} from "./port.ts";
import { callGatewayTool } from "./tools.ts";

function makePort(input?: {
  readonly controls?: Array<{ action: GatewayThreadControlAction; requestId: string }>;
  readonly approvals?: Array<{ requestId: string; decision: string }>;
  readonly operations?: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }>;
  readonly creates?: Array<{
    instanceId?: string;
    model: string;
    runtimeMode?: string;
    reasoningEffort?: string;
    profileId?: string;
  }>;
  readonly profiles?: ReadonlyArray<GatewayProfile>;
  readonly pendingApprovalPlan?: boolean;
  readonly staleApprovalPlan?: boolean;
  readonly threadActivities?: ReadonlyArray<Record<string, unknown>>;
  readonly projectOwner?: string;
}): GatewayRuntimePort {
  const environments = ["local", "remote"] as const;
  const threads = new Map<string, Array<Record<string, unknown>>>(
    environments.map((environmentId) => [environmentId, []]),
  );
  return {
    openThread: async (environmentId, threadId) => ({
      environmentId,
      threadId,
      status: "succeeded",
    }),
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
    ...(input?.profiles === undefined
      ? {}
      : { listProfiles: async () => input.profiles as ReadonlyArray<GatewayProfile> }),
    resolveProfileModelSelection: async (_environmentId, profile) =>
      profile.providerLabel === "Codex" && profile.modelLabel === "GPT-5.6 Sol"
        ? { instanceId: "codex", model: "gpt-5.6-sol" }
        : profile.modelSelection,
    listProjects: async (environmentId) => ({
      snapshotAt: "2026-09-02T00:00:00.000Z",
      items: [
        {
          id: `${environmentId}-project`,
          title: "Project",
          workspaceRoot: "/repo",
          repositoryIdentity: { owner: input?.projectOwner ?? "jayleaton", name: "t3code" },
        },
      ],
    }),
    listThreads: async (environmentId) => ({
      snapshotAt: "2026-09-02T00:00:00.000Z",
      items: threads.get(environmentId) ?? [],
    }),
    getThread: async (environmentId, threadId) => ({
      id: threadId,
      environmentId,
      messages: [
        {
          id: "message-1",
          role: "assistant",
          text: `hello from ${environmentId}`,
          attachments: [{ id: "asset-1", kind: "image", name: "result.png" }],
        },
      ],
      activities:
        input?.threadActivities ??
        (input?.pendingApprovalPlan
          ? [
              {
                id: "approval-1",
                sequence: 9,
                kind: "approval.requested",
                payload: { requestId: "approval-1", requestKind: "command", detail: "Run command" },
              },
              {
                id: "approval-2",
                sequence: 10,
                kind: "approval.requested",
                payload: { requestId: "approval-2", requestKind: "file-read", detail: "Read file" },
              },
              ...(input.staleApprovalPlan
                ? [
                    {
                      id: "approval-stale",
                      sequence: 11,
                      kind: "provider.approval.respond.failed",
                      payload: {
                        requestId: "approval-1",
                        detail: "Unknown pending approval request approval-1",
                      },
                    },
                  ]
                : []),
            ]
          : [
              { id: "event-1", sequence: 7, kind: "tool", summary: "Ran checks" },
              { id: "event-2", sequence: 8, kind: "info", summary: "Completed" },
            ]),
      checkpoints: [{ turnId: "turn-1", files: [{ path: "src/index.ts", kind: "modified" }] }],
    }),
    getPullRequest: async () => ({}),
    getPullRequestActivity: async () => ({}),
    createThread: async (request) => {
      input?.creates?.push({
        ...(request.modelSelection?.instanceId === undefined
          ? {}
          : { instanceId: request.modelSelection.instanceId }),
        model: request.modelSelection?.model ?? "server-default",
        ...(request.profileSelection === undefined
          ? {}
          : { profileId: request.profileSelection.profileId }),
        ...(request.runtimeMode === undefined ? {} : { runtimeMode: request.runtimeMode }),
        ...(request.modelSelection?.options?.find((option) => option.id === "reasoningEffort")
          ?.value === undefined
          ? {}
          : {
              reasoningEffort: String(
                request.modelSelection?.options?.find((option) => option.id === "reasoningEffort")
                  ?.value,
              ),
            }),
      });
      const thread = { id: request.threadId, projectId: request.projectId, title: request.title };
      threads.get(request.environmentId)?.push(thread);
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    },
    sendMessage: async (request) => ({
      requestId: request.requestId,
      commandId: request.requestId,
      status: "accepted",
      threadId: request.threadId,
      messageId: request.messageId,
    }),
    controlThread: async (request) => {
      input?.controls?.push({ action: request.action, requestId: request.requestId });
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    },
    respondToApproval: async (request) => {
      input?.approvals?.push({ requestId: request.approvalRequestId, decision: request.decision });
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    },
    executeOperation: async (request) => {
      input?.operations?.push({ operation: request.operation, payload: request.payload });
      return { operation: request.operation, requestId: request.requestId, accepted: true };
    },
  };
}

const grants = {
  local: [
    "read",
    "create",
    "send",
    "lifecycle",
    "approval",
    "artifact",
    "review",
    "admin",
    "delivery",
  ],
  remote: [
    "read",
    "create",
    "send",
    "lifecycle",
    "approval",
    "artifact",
    "review",
    "admin",
    "delivery",
  ],
} as const;

describe("gateway chat tools", () => {
  it("uses current per-environment read grants for opening chats", async () => {
    const port = makePort();
    const open = vi.spyOn(port, "openThread");
    let current: Record<string, readonly ("read" | "send")[]> = {
      remote: ["send"],
      local: ["read"],
    };
    const context = { port, grants: () => current };
    await expect(
      callGatewayTool(context, "t3_open_thread", { environmentId: "remote", threadId: "chat" }),
    ).rejects.toMatchObject({
      code: "scope_required",
      details: { requiredScopes: ["read"], missingScopes: ["read"], grantedScopes: ["send"] },
    });
    expect(open).not.toHaveBeenCalled();
    current = { ...current, remote: ["read"] };
    await expect(
      callGatewayTool(context, "t3_open_thread", { environmentId: "remote", threadId: "chat" }),
    ).resolves.toEqual({ environmentId: "remote", threadId: "chat", status: "succeeded" });
    current = { local: ["read"] };
    await expect(
      callGatewayTool(context, "t3_open_thread", { environmentId: "remote", threadId: "chat" }),
    ).rejects.toMatchObject({ code: "unknown_environment" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("focuses a chat, a file, or the Agents board on a named device", async () => {
    const focused: Array<{ device: string; target: unknown }> = [];
    const context = {
      port: {
        ...makePort(),
        focusDevice: async (_environmentId: string, device: string, target: unknown) => {
          focused.push({ device, target });
          return { deviceId: "win", label: "WIN-STUDIO", status: "delivered" as const };
        },
      },
      grants: { remote: ["read"] as const },
    };
    const focus = (input: Record<string, unknown>) =>
      callGatewayTool(context, "t3_focus_device", {
        environmentId: "remote",
        device: "WIN-STUDIO",
        ...input,
      });

    await focus({ threadId: "chat" });
    await focus({ threadId: "chat", path: "shots/after.png", line: 3 });
    await focus({ view: "agents" });
    expect(focused).toEqual([
      { device: "WIN-STUDIO", target: { type: "thread", threadId: "chat" } },
      {
        device: "WIN-STUDIO",
        target: { type: "file", threadId: "chat", path: "shots/after.png", line: 3 },
      },
      { device: "WIN-STUDIO", target: { type: "agents" } },
    ]);
    await expect(focus({ path: "shots/after.png" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(focus({ threadId: "chat", line: 3 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      callGatewayTool({ ...context, grants: { remote: ["send"] as const } }, "t3_focus_device", {
        environmentId: "remote",
        device: "WIN-STUDIO",
        threadId: "chat",
      }),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(focused).toHaveLength(3);
  });

  it("routes todo tools to the runtime port, writes needing create access", async () => {
    const requests: unknown[] = [];
    const context = {
      port: {
        ...makePort(),
        todo: async (_environmentId: string, request: unknown) => {
          requests.push(request);
          return { removed: "t1" };
        },
      },
      grants: { remote: ["read", "create"] as const, readOnly: ["read"] as const },
    };
    await callGatewayTool(context, "t3_list_todos", { environmentId: "remote", projectId: "p" });
    await callGatewayTool(context, "t3_add_todo", {
      environmentId: "remote",
      projectId: "p",
      text: "Ship it",
    });
    await callGatewayTool(context, "t3_settle_todo", { environmentId: "remote", todoId: "t1" });
    await callGatewayTool(context, "t3_unsettle_todo", { environmentId: "remote", todoId: "t1" });
    await callGatewayTool(context, "t3_remove_todo", { environmentId: "remote", todoId: "t1" });
    expect(requests).toEqual([
      { action: "list", projectId: "p" },
      { action: "add", projectId: "p", text: "Ship it" },
      { action: "settle", todoId: "t1" },
      { action: "unsettle", todoId: "t1" },
      { action: "remove", todoId: "t1" },
    ]);

    await expect(
      callGatewayTool(context, "t3_settle_todo", { environmentId: "readOnly", todoId: "t1" }),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(requests).toHaveLength(5);
  });

  it("runs task tools as the invoking chat, never from input", async () => {
    const calls: Array<{ request: unknown; caller: unknown }> = [];
    const context = {
      port: {
        ...makePort(),
        threadTask: async (_environmentId: string, request: unknown, caller?: unknown) => {
          calls.push({ request, caller });
          return { tasks: [], cursor: 0, timedOut: false };
        },
      },
      grants: {
        remote: ["read", "create", "lifecycle"] as const,
        readOnly: ["read"] as const,
        createOnly: ["create"] as const,
      },
    };
    const caller = { environmentId: "remote", threadId: "worker" };
    await callGatewayTool(
      context,
      "t3_task_update",
      { environmentId: "remote", expectedRevision: 2, status: "DONE", evidence: ["PR merged"] },
      { caller },
    );
    await callGatewayTool(context, "t3_task_read", { environmentId: "remote" }, { caller });
    await callGatewayTool(context, "t3_settle_after_turn", { environmentId: "remote" }, { caller });
    await callGatewayTool(context, "t3_task_read", { environmentId: "remote" });
    expect(calls).toEqual([
      {
        request: {
          action: "update",
          input: { expectedRevision: 2, status: "DONE", evidence: ["PR merged"] },
        },
        caller,
      },
      { request: { action: "read", input: {} }, caller },
      { request: { action: "settleAfterTurn", input: {} }, caller },
      { request: { action: "read", input: {} }, caller: undefined },
    ]);

    // Identity fields are not part of any task tool's input.
    for (const forged of [{ caller }, { callerThreadId: "owner" }, { kind: "user" }]) {
      await expect(
        callGatewayTool(context, "t3_task_read", { environmentId: "remote", ...forged }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(calls).toHaveLength(4);
  });

  it("requires read, create, or lifecycle access per task tool", async () => {
    const threadTask = vi.fn(async () => ({ tasks: [], cursor: 0, timedOut: false }));
    const context = {
      port: { ...makePort(), threadTask },
      grants: {
        readOnly: ["read"] as const,
        createOnly: ["create"] as const,
        lifecycleOnly: ["lifecycle"] as const,
      },
    };
    const assign = { threadId: "child", summary: "Ship it" };
    await callGatewayTool(context, "t3_task_read", { environmentId: "readOnly" });
    await callGatewayTool(context, "t3_task_watch", { environmentId: "readOnly", timeoutMs: 10 });
    await callGatewayTool(context, "t3_task_assign", { environmentId: "createOnly", ...assign });
    await callGatewayTool(context, "t3_settle_after_turn", { environmentId: "lifecycleOnly" });
    expect(threadTask).toHaveBeenCalledTimes(4);

    for (const [name, environmentId, extra] of [
      ["t3_task_assign", "readOnly", assign],
      ["t3_task_update", "readOnly", { expectedRevision: 1 }],
      ["t3_task_read", "createOnly", {}],
      ["t3_task_watch", "lifecycleOnly", {}],
      ["t3_settle_after_turn", "createOnly", {}],
    ] as const) {
      await expect(
        callGatewayTool(context, name, { environmentId, ...extra }),
      ).rejects.toMatchObject({ code: "scope_required" });
    }
    expect(threadTask).toHaveBeenCalledTimes(4);
  });

  it("surfaces a task error's code and detail", async () => {
    const context = {
      port: {
        ...makePort(),
        threadTask: async () => {
          throw Object.assign(new Error("stale"), {
            _tag: "ThreadTaskError",
            code: "revision_conflict",
            detail: "Task is at revision 3.",
            currentRevision: 3,
          });
        },
      },
      grants: { remote: ["create"] as const },
    };
    await expect(
      callGatewayTool(context, "t3_task_update", { environmentId: "remote", expectedRevision: 1 }),
    ).rejects.toMatchObject({
      message: "revision_conflict: Task is at revision 3.",
      details: { taskErrorCode: "revision_conflict", currentRevision: 3 },
    });
  });

  it("turns runAt or cron into a schedule for scheduled tasks", async () => {
    const requests: unknown[] = [];
    const context = {
      port: {
        ...makePort(),
        scheduledTask: async (_environmentId: string, request: unknown) => {
          requests.push(request);
          return { tasks: [] };
        },
      },
      grants: { remote: ["read", "create"] as const },
    };
    const base = { environmentId: "remote", prompt: "git pull", profileId: "a", projectId: "p" };

    await callGatewayTool(context, "t3_create_scheduled_task", {
      ...base,
      cron: "0 7 * * *",
      timezone: "Asia/Bangkok",
    });
    await callGatewayTool(context, "t3_create_scheduled_task", {
      ...base,
      runAt: "2026-09-25T02:00:00Z",
    });
    await callGatewayTool(context, "t3_update_scheduled_task", {
      environmentId: "remote",
      taskId: "t1",
      patch: { enabled: false },
    });
    expect(requests).toEqual([
      {
        action: "create",
        input: {
          prompt: "git pull",
          profileId: "a",
          projectId: "p",
          schedule: { type: "cron", expression: "0 7 * * *", timezone: "Asia/Bangkok" },
        },
      },
      {
        action: "create",
        input: {
          prompt: "git pull",
          profileId: "a",
          projectId: "p",
          schedule: { type: "once", runAt: "2026-09-25T02:00:00Z" },
        },
      },
      { action: "update", taskId: "t1", patch: { enabled: false } },
    ]);

    await expect(callGatewayTool(context, "t3_create_scheduled_task", base)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      callGatewayTool(context, "t3_create_scheduled_task", {
        ...base,
        runAt: "2026-09-25T02:00:00Z",
        cron: "0 7 * * *",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      callGatewayTool(context, "t3_run_scheduled_task", { environmentId: "remote", taskId: "t1" }),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(requests).toHaveLength(3);
  });

  it.each(["local", "remote"])("reads, creates, and sends chats in %s", async (environmentId) => {
    const port = makePort();
    const context = { port, grants };

    const listed = await callGatewayTool(context, "t3_list_threads", { environmentId });
    expect(listed).toMatchObject({ items: [] });

    const created = await callGatewayTool(context, "t3_create_thread", {
      environmentId,
      projectId: `${environmentId}-project`,
      title: "Gateway chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: `${environmentId}-create-1`,
    });
    expect(created).toMatchObject({
      status: "accepted",
      requestId: expect.stringMatching(/^mcp-thread-v2-/u),
      threadId: expect.stringMatching(/^mcp-thread-v2-/u),
    });

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

  it("parents chats a T3 chat creates on any environment", async () => {
    const base = makePort();
    const parents: Array<[string | undefined, string | undefined]> = [];
    const context = {
      port: {
        ...base,
        listThreads: async (environmentId: string) => ({
          snapshotAt: "2026-09-02T00:00:00.000Z",
          items:
            environmentId === "local"
              ? [{ id: "coordinator" }, { id: "other-parent" }, { id: "archived-parent" }]
              : [],
        }),
        getThread: async (environmentId: string, threadId: string) => {
          if (
            environmentId !== "local" ||
            !["coordinator", "other-parent", "archived-parent"].includes(threadId)
          )
            throw new Error("Failed to load thread");
          const thread = await base.getThread(environmentId, threadId);
          return threadId === "archived-parent"
            ? { ...thread, archivedAt: "2026-09-01T00:00:00.000Z" }
            : thread;
        },
        createThread: async (request: Parameters<typeof base.createThread>[0]) => {
          parents.push([request.parentThreadId, request.parentEnvironmentId]);
          return base.createThread(request);
        },
      },
      grants,
    };
    const invocation = { caller: { environmentId: "local", threadId: "coordinator" } };
    const create = (input: Record<string, unknown>, key: string) =>
      callGatewayTool(
        context,
        "t3_create_thread",
        {
          environmentId: "local",
          projectId: "local-project",
          title: "Child",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          idempotencyKey: key,
          ...input,
        },
        invocation,
      );

    await create({}, "child-default");
    await create({ parentThreadId: "other-parent" }, "child-explicit");
    await create({ parentThreadId: null }, "child-standalone");
    await create({ environmentId: "remote", projectId: "remote-project" }, "child-remote");
    // Naming itself as the parent of a chat on another machine means the caller's environment.
    await create(
      { environmentId: "remote", projectId: "remote-project", parentThreadId: "coordinator" },
      "child-remote-self",
    );
    await callGatewayTool(
      context,
      "t3_create_and_start_thread",
      {
        environmentId: "local",
        projectId: "local-project",
        title: "Started child",
        text: "Go",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        idempotencyKey: "child-started",
      },
      invocation,
    );

    expect(parents).toEqual([
      ["coordinator", undefined],
      ["other-parent", undefined],
      [undefined, undefined],
      // A chat on another machine records which environment its parent is on.
      ["coordinator", "local"],
      ["coordinator", "local"],
      ["coordinator", undefined],
    ]);

    // An MCP request namespace copied out of a task ID is not a chat on either environment.
    const fake = "mcp:b33476a4-892a-4ec5-a923-2a98b0bd14e5";
    for (const [input, key] of [
      [
        {
          environmentId: "remote",
          projectId: "remote-project",
          parentThreadId: fake,
          parentEnvironmentId: "local",
        },
        "fake-remote",
      ],
      [{ parentThreadId: fake }, "fake-local"],
      [{ parentThreadId: "archived-parent" }, "archived"],
    ] as const) {
      await expect(create(input, key)).rejects.toMatchObject({
        code: "invalid_input",
        message: `parentThreadId ${input.parentThreadId} is not a chat on environment local; omit parentThreadId to nest under the calling chat.`,
      });
    }
    expect(parents).toHaveLength(6);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "does not inherit a grant for %s",
    async (environmentId) => {
      const context = {
        port: {
          ...makePort(),
          listEnvironments: async () => [
            {
              environmentId,
              label: environmentId,
              targetKind: "primary",
              connectionState: "connected",
            },
          ],
        },
        grants: {},
      };
      expect(await callGatewayTool(context, "t3_list_environments", {})).toMatchObject({
        items: [],
      });
      await expect(
        callGatewayTool(context, "t3_get_thread", { environmentId, threadId: "thread" }),
      ).rejects.toMatchObject({ code: "unknown_environment" });
    },
  );

  it("reports a thread missing from its environment as thread_not_found, not a retryable failure", async () => {
    const failing = (listed: ReadonlyArray<string>): GatewayRuntimePort => ({
      ...makePort(),
      getThread: async (_environmentId, threadId) => {
        throw new Error(`Failed to load orchestration V2 thread ${threadId}`);
      },
      listThreads: async () => ({
        items: listed.map((id) => ({ id })),
        snapshotAt: "now",
      }),
    });
    await expect(
      callGatewayTool({ port: failing([]), grants }, "t3_get_thread", {
        environmentId: "local",
        threadId: "77647f60",
      }),
    ).rejects.toMatchObject({ code: "thread_not_found", retryable: false, environmentId: "local" });
    // A thread the environment still lists failed for another reason, which stays as it was.
    await expect(
      callGatewayTool({ port: failing(["thread-1"]), grants }, "t3_summarize_thread", {
        environmentId: "local",
        threadId: "thread-1",
      }),
    ).rejects.toThrow("Failed to load orchestration V2 thread thread-1");
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

  it.each(["running", "queued", "stopped", "interrupted"])(
    "summarizes authoritative %s state ahead of a stale completed turn",
    async (status) => {
      const result = await callGatewayTool(
        {
          port: {
            ...makePort(),
            getThread: async () => ({
              id: "thread-1",
              status,
              latestTurn: { state: "completed" },
              messages: [],
            }),
          },
          grants,
        },
        "t3_summarize_thread",
        { environmentId: "local", threadId: "thread-1" },
      );
      expect(result).toMatchObject({
        status,
        nextAction: status === "running" || status === "queued" ? "await_event" : null,
      });
    },
  );

  it("honors and revokes the explicit control compatibility scope", async () => {
    let enabled = false;
    const controls: Array<{ action: GatewayThreadControlAction; requestId: string }> = [];
    const context = {
      port: makePort({ controls }),
      grants: () => ({ local: enabled ? (["control"] as const) : ([] as const) }),
    };
    const request = {
      environmentId: "local",
      threadId: "thread-1",
      action: "stop",
      idempotencyKey: "control-compat-1",
    };

    await expect(callGatewayTool(context, "t3_control_thread", request)).rejects.toMatchObject({
      code: "scope_required",
      details: { missingScopes: ["control", "lifecycle"] },
    });
    enabled = true;
    await expect(callGatewayTool(context, "t3_control_thread", request)).resolves.toMatchObject({
      status: "accepted",
    });
    expect(controls).toHaveLength(1);
    enabled = false;
    await expect(callGatewayTool(context, "t3_control_thread", request)).rejects.toMatchObject({
      code: "scope_required",
    });
    expect(controls).toHaveLength(1);
  });

  it("defers named profile defaults to the server while keeping the agent's permission mode", async () => {
    const creates: Array<{ model: string; runtimeMode?: string; reasoningEffort?: string }> = [];
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile-andy",
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        reasoningEffort: "medium",
        runtimeMode: "full-access",
        interactionMode: "default",
        revision: 2,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T01:00:00.000Z",
      },
    ];
    const browserLocalProfiles: ReadonlyArray<GatewayProfile> = [
      {
        name: "Andy",
        modelSelection: { instanceId: "codex", model: "stale-local-model" },
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    ];
    const context = {
      port: makePort({ creates, profiles }),
      grants,
      profiles: browserLocalProfiles,
    };

    await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Profiled chat",
      profile: "Andy",
      idempotencyKey: "profile-create-1",
    });
    await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Overridden chat",
      profile: "Andy",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      idempotencyKey: "profile-create-2",
    });

    expect(creates).toEqual([
      {
        instanceId: "glm",
        model: "glm-5.3",
        runtimeMode: "full-access",
        reasoningEffort: "medium",
        profileId: "profile-andy",
      },
      {
        instanceId: "codex",
        model: "gpt-5",
        runtimeMode: "full-access",
        reasoningEffort: "medium",
        profileId: "profile-andy",
      },
    ]);
  });

  it.each(["cancel", "stop", "pause", "resume", "retry", "restart"] as const)(
    "forwards idempotent %s lifecycle control",
    async (action) => {
      const controls: Array<{ action: GatewayThreadControlAction; requestId: string }> = [];
      const result = await callGatewayTool(
        { port: makePort({ controls }), grants },
        "t3_control_thread",
        {
          environmentId: "local",
          threadId: "thread-1",
          action,
          idempotencyKey: `${action}-1`,
        },
      );

      expect(result).toMatchObject({ status: "accepted", threadId: "thread-1" });
      expect(controls).toEqual([
        { action, requestId: expect.stringMatching(/^mcp-thread-control-v2-/u) as string },
      ]);
    },
  );

  it("scopes authoritative approval command ids to the owning thread", async () => {
    const commandIds: string[] = [];
    const port = makePort({ pendingApprovalPlan: true });
    port.respondToApproval = async (request) => {
      commandIds.push(request.requestId);
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    };
    const events = createGatewayEventStore();
    const base = {
      environmentId: "local",
      approvalRequestId: "approval-2",
      decision: "decline",
      idempotencyKey: "same-caller-key",
    } as const;

    await callGatewayTool({ port, grants, events }, "t3_respond_to_approval", {
      ...base,
      threadId: "thread-1",
    });
    await callGatewayTool({ port, grants, events }, "t3_respond_to_approval", {
      ...base,
      threadId: "thread-2",
    });

    expect(commandIds).toHaveLength(2);
    expect(commandIds[0]).toMatch(/^mcp-approval-response-v2-/u);
    expect(commandIds[1]).toMatch(/^mcp-approval-response-v2-/u);
    expect(commandIds[0]).not.toBe(commandIds[1]);
    events.close();
  });

  it("requires explicit confirmation before accepting a destructive approval", async () => {
    const approvals: Array<{ requestId: string; decision: string }> = [];
    const context = {
      port: makePort({ approvals, pendingApprovalPlan: true }),
      grants: { local: ["read", "approval"] },
    } as const;
    const request = {
      environmentId: "local",
      threadId: "thread-1",
      approvalRequestId: "approval-1",
      decision: "accept",
      idempotencyKey: "approval-decision-1",
    };

    await expect(callGatewayTool(context, "t3_respond_to_approval", request)).rejects.toMatchObject(
      {
        code: "destructive_confirmation_required",
      },
    );
    expect(approvals).toEqual([]);

    await callGatewayTool(context, "t3_respond_to_approval", {
      ...request,
      confirmDestructive: true,
    });
    expect(approvals).toEqual([{ requestId: "approval-1", decision: "accept" }]);
  });

  it("accepts approvals that a V2 runtime lists as pending", async () => {
    const approvals: Array<{ requestId: string; decision: string }> = [];
    const port = makePort({ approvals });
    const getThread = port.getThread;
    port.getThread = async (environmentId, threadId) => ({
      ...(await getThread(environmentId, threadId)),
      activities: undefined,
      pendingApprovals: [
        { requestId: "approval-v2", requestKind: "command", detail: "rm -rf build" },
      ],
    });
    const context = { port, grants: { local: ["read", "approval"] } } as const;

    const summary = await callGatewayTool(context, "t3_summarize_thread", {
      environmentId: "local",
      threadId: "thread-1",
    });
    expect(JSON.stringify(summary)).toContain("rm -rf build");
    await callGatewayTool(context, "t3_respond_to_approval", {
      environmentId: "local",
      threadId: "thread-1",
      approvalRequestId: "approval-v2",
      decision: "accept",
      confirmDestructive: true,
      idempotencyKey: "approval-v2-accept",
    });
    expect(approvals).toEqual([{ requestId: "approval-v2", decision: "accept" }]);
  });

  it("rejects destructive acceptance for approval requests absent from the plan", async () => {
    const approvals: Array<{ requestId: string; decision: string }> = [];
    const context = {
      port: makePort({ approvals }),
      grants: { local: ["read", "approval"] },
    } as const;

    // No pendingApprovalPlan: the request ID is not pending anywhere, yet it
    // used to fall through the optional-action check and dispatch.
    await expect(
      callGatewayTool(context, "t3_respond_to_approval", {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision: "accept",
        confirmDestructive: true,
        idempotencyKey: "approval-absent-1",
      }),
    ).rejects.toMatchObject({ code: "stale_plan" });
    expect(approvals).toEqual([]);
  });

  it("fails closed when a pending destructive approval falls outside the projected activity window", async () => {
    const approvals: Array<{ requestId: string; decision: string }> = [];
    // Faithfully models gatewayThreadProjection's newest-1,000 activity slice:
    // approval.requested exists in the source snapshot but is omitted from the
    // DTO consumed by this package after 1,000 newer unique activities.
    const sourceActivities = [
      {
        id: "approval-1",
        sequence: 1,
        kind: "approval.requested",
        payload: { requestId: "approval-1", requestKind: "command", detail: "Run command" },
      },
      ...Array.from({ length: 1_000 }, (_, index) => ({
        id: `activity-${index + 2}`,
        sequence: index + 2,
        kind: "info",
        summary: "filler",
      })),
    ];
    const context = {
      port: makePort({ approvals, threadActivities: sourceActivities.slice(-1_000) }),
      grants: { local: ["read", "approval"] },
    } as const;

    await expect(
      callGatewayTool(context, "t3_respond_to_approval", {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision: "accept",
        confirmDestructive: true,
        idempotencyKey: "approval-truncated-1",
      }),
    ).rejects.toMatchObject({ code: "stale_plan" });

    await expect(
      callGatewayTool(context, "t3_respond_to_approval", {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision: "acceptForSession",
        confirmDestructive: true,
        idempotencyKey: "approval-truncated-2",
      }),
    ).rejects.toMatchObject({ code: "stale_plan" });
    expect(approvals).toEqual([]);
  });

  it("still dispatches non-destructive decisions for known pending actions after the fail-closed check", async () => {
    const approvals: Array<{ requestId: string; decision: string }> = [];
    const context = {
      port: makePort({ approvals, pendingApprovalPlan: true }),
      grants: { local: ["read", "approval"] },
    } as const;

    await callGatewayTool(context, "t3_respond_to_approval", {
      environmentId: "local",
      threadId: "thread-1",
      approvalRequestId: "approval-2",
      decision: "acceptForSession",
      idempotencyKey: "approval-session-1",
    });
    expect(approvals).toEqual([{ requestId: "approval-2", decision: "acceptForSession" }]);
  });

  it.each(["accept", "acceptForSession"] as const)(
    "replays a resolved %s receipt after reopening the durable store and rejects changed payloads",
    async (decision) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-approval-"));
      const file = NodePath.join(directory, "events.sqlite");
      const activities: Array<Record<string, unknown>> = [
        {
          id: "approval-1",
          sequence: 1,
          kind: "approval.requested",
          payload: { requestId: "approval-1", requestKind: "command", detail: "Run command" },
        },
      ];
      const approvals: Array<{ requestId: string; decision: string }> = [];
      const port = makePort({ approvals, threadActivities: activities });
      port.respondToApproval = async (request) => {
        approvals.push({ requestId: request.approvalRequestId, decision: request.decision });
        activities.push({
          id: "approval-resolved-1",
          sequence: 2,
          kind: "approval.resolved",
          payload: { requestId: request.approvalRequestId },
        });
        return {
          requestId: request.requestId,
          commandId: request.requestId,
          status: "accepted",
          threadId: request.threadId,
        };
      };
      const request = {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision,
        confirmDestructive: true,
        idempotencyKey: `approval-replay-${decision}`,
      };
      let events = createGatewayEventStore({ file });
      try {
        const first = await callGatewayTool(
          { port, grants, events },
          "t3_respond_to_approval",
          request,
        );
        events.close();
        events = createGatewayEventStore({ file });

        await expect(
          callGatewayTool({ port, grants, events }, "t3_respond_to_approval", request),
        ).resolves.toEqual(first);
        await expect(
          callGatewayTool({ port, grants, events }, "t3_respond_to_approval", {
            ...request,
            confirmDestructive: false,
          }),
        ).rejects.toMatchObject({ code: "idempotency_conflict" });
        expect(approvals).toHaveLength(1);
      } finally {
        events.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["accept", "acceptForSession"] as const)(
    "replays an in-flight %s response after the approval resolves",
    async (decision) => {
      const activities: Array<Record<string, unknown>> = [
        {
          id: "approval-1",
          sequence: 1,
          kind: "approval.requested",
          payload: { requestId: "approval-1", requestKind: "command", detail: "Run command" },
        },
      ];
      const events = createGatewayEventStore();
      const response = Promise.withResolvers<GatewayMutationResult>();
      let dispatches = 0;
      const port = makePort({ threadActivities: activities });
      port.respondToApproval = async (request) => {
        dispatches += 1;
        activities.push({
          id: "approval-resolved-1",
          sequence: 2,
          kind: "approval.resolved",
          payload: { requestId: request.approvalRequestId },
        });
        return response.promise;
      };
      const request = {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision,
        confirmDestructive: true,
        idempotencyKey: `approval-in-flight-${decision}`,
      };

      const first = callGatewayTool({ port, grants, events }, "t3_respond_to_approval", request);
      await Promise.resolve();
      const replay = callGatewayTool({ port, grants, events }, "t3_respond_to_approval", request);
      response.resolve({
        requestId: `mcp-request-${request.idempotencyKey}`,
        status: "accepted",
        threadId: "thread-1",
        commandId: `mcp-request-${request.idempotencyKey}`,
      });

      await expect(replay).resolves.toEqual(await first);
      expect(dispatches).toBe(1);
      events.close();
    },
  );

  it.each(["accept", "acceptForSession"] as const)(
    "rechecks approval grants before replaying a resolved %s receipt",
    async (decision) => {
      const activities: Array<Record<string, unknown>> = [
        {
          id: "approval-1",
          sequence: 1,
          kind: "approval.requested",
          payload: { requestId: "approval-1", requestKind: "command", detail: "Run command" },
        },
      ];
      const events = createGatewayEventStore();
      let approvalGranted = true;
      const port = makePort({ threadActivities: activities });
      port.respondToApproval = async (request) => {
        activities.push({
          id: "approval-resolved-1",
          sequence: 2,
          kind: "approval.resolved",
          payload: { requestId: request.approvalRequestId },
        });
        return {
          requestId: request.requestId,
          status: "accepted",
          threadId: request.threadId,
          commandId: request.requestId,
        };
      };
      const context = {
        port,
        events,
        grants: () => ({ local: approvalGranted ? (["approval"] as const) : ([] as const) }),
      };
      const request = {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision,
        confirmDestructive: true,
        idempotencyKey: `approval-revoked-${decision}`,
      };

      await callGatewayTool(context, "t3_respond_to_approval", request);
      approvalGranted = false;
      await expect(
        callGatewayTool(context, "t3_respond_to_approval", request),
      ).rejects.toMatchObject({
        code: "scope_required",
      });
      events.close();
    },
  );

  it.each(["accept", "acceptForSession"] as const)(
    "recovers an accepted %s after the runtime response is lost and the store reopens",
    async (decision) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-lost-"));
      const file = NodePath.join(directory, "events.sqlite");
      const activities: Array<Record<string, unknown>> = [
        {
          id: "approval-1",
          sequence: 1,
          kind: "approval.requested",
          payload: { requestId: "approval-1", requestKind: "command", detail: "Run command" },
        },
      ];
      const receipts = new Map<string, GatewayMutationResult>();
      let sideEffects = 0;
      let loseResponse = true;
      const port = makePort({ threadActivities: activities });
      port.respondToApproval = async (request) => {
        const previous = receipts.get(request.requestId);
        if (previous !== undefined) return previous;
        sideEffects += 1;
        activities.push({
          id: "approval-resolved-1",
          sequence: 2,
          kind: "approval.resolved",
          payload: { requestId: request.approvalRequestId },
        });
        const receipt = {
          requestId: request.requestId,
          commandId: request.requestId,
          status: "accepted" as const,
          threadId: request.threadId,
        };
        receipts.set(request.requestId, receipt);
        if (loseResponse) throw new Error("transport disconnected after authoritative acceptance");
        return receipt;
      };
      const request = {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision,
        confirmDestructive: true,
        idempotencyKey: `approval-lost-${decision}`,
      };
      let events = createGatewayEventStore({ file });
      try {
        await expect(
          callGatewayTool({ port, grants, events }, "t3_respond_to_approval", request),
        ).rejects.toThrow("transport disconnected after authoritative acceptance");
        events.close();
        events = createGatewayEventStore({ file });
        loseResponse = false;

        await expect(
          callGatewayTool({ port, grants, events }, "t3_respond_to_approval", request),
        ).resolves.toEqual([...receipts.values()][0]);
        expect(sideEffects).toBe(1);
      } finally {
        events.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("does not recover a null request whose validation failed before dispatch", async () => {
    const events = createGatewayEventStore();
    const approvals: Array<{ requestId: string; decision: string }> = [];
    const context = { port: makePort({ approvals }), grants, events };
    const request = {
      environmentId: "local",
      threadId: "thread-1",
      approvalRequestId: "approval-1",
      decision: "accept",
      confirmDestructive: true,
      idempotencyKey: "approval-validation-failed",
    };

    await expect(callGatewayTool(context, "t3_respond_to_approval", request)).rejects.toMatchObject(
      {
        code: "stale_plan",
      },
    );
    await expect(callGatewayTool(context, "t3_respond_to_approval", request)).rejects.toMatchObject(
      {
        code: "stale_plan",
      },
    );
    expect(approvals).toEqual([]);
    events.close();
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

describe("gateway v3 event delivery tools", () => {
  it("replays an identical create request instead of running it twice", async () => {
    const creates: Array<{ model: string; runtimeMode?: string; reasoningEffort?: string }> = [];
    const events = createGatewayEventStore();
    const context = { port: makePort({ creates }), grants, events };
    const request = {
      environmentId: "local",
      projectId: "local-project",
      title: "Idempotent chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: "create-idem-1",
    };

    const first = await callGatewayTool(context, "t3_create_thread", request);
    const second = await callGatewayTool(context, "t3_create_thread", request);

    expect(creates).toEqual([
      { instanceId: "codex", model: "gpt-5", runtimeMode: "approval-required" },
    ]);
    expect(first).toMatchObject({
      requestId: expect.stringMatching(/^mcp-thread-v2-/u),
      threadId: expect.stringMatching(/^mcp-thread-v2-/u),
    });
    expect(second).toEqual(first);
  });

  it("recovers either accepted pre-v2 create identity without dispatching an ambiguous command", async () => {
    for (const acceptedRequestId of [
      "mcp-request-migrating-create",
      "mcp-thread-migrating-create",
    ]) {
      const events = createGatewayEventStore();
      const port = makePort();
      const queried: Array<ReadonlyArray<string>> = [];
      port.createThread = async () => {
        throw new Error("An ambiguous historical create must not be dispatched.");
      };
      port.getCommandReceipts = async (_environmentId, commandIds) => {
        queried.push(commandIds);
        return [
          {
            commandId: acceptedRequestId,
            aggregateKind: "thread",
            aggregateId: "mcp-thread-migrating-create",
            acceptedAt: "2026-09-05T00:00:00.000Z",
            status: "accepted",
            resultSequence: 5,
            error: null,
          },
        ];
      };
      const request = {
        environmentId: "local",
        projectId: "local-project",
        title: "Migrated chat",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        idempotencyKey: "migrating-create",
      };
      const key = "local::mcp-thread-migrating-create";
      events.rememberRequest(
        key,
        `{"environmentId":"local","idempotencyKey":"migrating-create","modelSelection":{"instanceId":"codex","model":"gpt-5"},"projectId":"local-project","title":"Migrated chat"}`,
        null,
      );
      events.markRequestDispatched(key, undefined);

      const recovered = await callGatewayTool(
        { port, grants, events },
        "t3_create_thread",
        request,
      );
      const replay = await callGatewayTool({ port, grants, events }, "t3_create_thread", request);

      expect(queried).toEqual([["mcp-request-migrating-create", "mcp-thread-migrating-create"]]);
      expect(recovered).toEqual({
        requestId: acceptedRequestId,
        commandId: acceptedRequestId,
        status: "accepted",
        threadId: "mcp-thread-migrating-create",
      });
      expect(replay).toEqual(recovered);
      events.close();
    }
  });

  it("uses distinct authoritative command ids for create and same-key send", async () => {
    const events = createGatewayEventStore();
    const port = makePort();
    const commandIds: string[] = [];
    port.createThread = async (request) => {
      commandIds.push(request.requestId);
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    };
    port.sendMessage = async (request) => {
      commandIds.push(request.requestId);
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
        messageId: request.messageId,
      };
    };
    const input = {
      environmentId: "local",
      idempotencyKey: "create-send-key",
    };
    const created = await callGatewayTool({ port, grants, events }, "t3_create_thread", {
      ...input,
      projectId: "local-project",
      title: "Created chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
    });
    await callGatewayTool({ port, grants, events }, "t3_send_message", {
      ...input,
      threadId: created.threadId,
      text: "Run once",
    });

    expect(commandIds).toHaveLength(2);
    expect(commandIds[0]).not.toBe(commandIds[1]);
    events.close();
  });

  it("uses a new authoritative command id after a historical v2 same-key create", async () => {
    const events = createGatewayEventStore();
    const threadId = `mcp-thread-v2-${NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          aggregateId: "create",
          environmentId: "local",
          idempotencyKey: "create-send-key",
          version: 2,
        }),
      )
      .digest("hex")}`;
    const historicalCreateRequestId = `mcp-request-v2-${NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          aggregateId: threadId,
          environmentId: "local",
          idempotencyKey: "create-send-key",
          version: 2,
        }),
      )
      .digest("hex")}`;
    const dispatched: string[] = [];
    const port = makePort();
    port.sendMessage = async (request) => {
      dispatched.push(request.requestId);
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
        messageId: request.messageId,
      };
    };

    await callGatewayTool({ port, grants, events }, "t3_send_message", {
      environmentId: "local",
      threadId,
      text: "Must not replay the create receipt",
      idempotencyKey: "create-send-key",
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).not.toBe(historicalCreateRequestId);
    events.close();
  });

  it.each(["completed", "dispatched"] as const)(
    "fails closed for an ambiguous historical v2 %s send row after reopen",
    async (state) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-send-upgrade-"));
      const file = NodePath.join(directory, "gateway.sqlite");
      const input = {
        environmentId: "local",
        threadId: "thread-1",
        text: "Do not replay an ambiguous receipt",
        idempotencyKey: "historical-send",
      };
      const key = "local::thread-1::mcp-request-historical-send";
      const historicalRequestId = `mcp-request-v2-${NodeCrypto.createHash("sha256")
        .update(
          JSON.stringify({
            aggregateId: "thread-1",
            environmentId: "local",
            idempotencyKey: "historical-send",
            version: 2,
          }),
        )
        .digest("hex")}`;
      let events = createGatewayEventStore({ file });
      events.rememberRequest(
        key,
        `{"input":{"environmentId":"local","idempotencyKey":"historical-send","text":"Do not replay an ambiguous receipt","threadId":"thread-1"},"operation":"message.send"}`,
        null,
      );
      if (state === "completed") {
        events.completeRequest(key, {
          requestId: historicalRequestId,
          commandId: historicalRequestId,
          status: "accepted",
          threadId: "thread-1",
          messageId: "mcp-message-historical-send",
        });
      } else {
        events.markRequestDispatched(key, {
          requestId: historicalRequestId,
          messageId: "mcp-message-historical-send",
        });
      }
      events.close();
      events = createGatewayEventStore({ file });
      const sends: string[] = [];
      const port = makePort();
      port.sendMessage = async (request) => {
        sends.push(request.requestId);
        return {
          requestId: request.requestId,
          commandId: request.requestId,
          status: "accepted",
          threadId: request.threadId,
          messageId: request.messageId,
        };
      };

      await expect(
        callGatewayTool({ port, grants, events }, "t3_send_message", input),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(sends).toEqual([]);
      events.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  );

  it.each(["completed", "dispatched"] as const)(
    "replays a historical %s send when its message exists outside the bounded projection",
    async (state) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-send-replay-"));
      const file = NodePath.join(directory, "gateway.sqlite");
      const input = {
        environmentId: "local",
        threadId: "thread-1",
        text: "Already stored",
        idempotencyKey: "verified-historical-send",
      };
      const key = "local::thread-1::mcp-request-verified-historical-send";
      const historicalRequestId = `mcp-request-v2-${NodeCrypto.createHash("sha256")
        .update(
          JSON.stringify({
            aggregateId: "thread-1",
            environmentId: "local",
            idempotencyKey: "verified-historical-send",
            version: 2,
          }),
        )
        .digest("hex")}`;
      const receipt = {
        requestId: historicalRequestId,
        commandId: historicalRequestId,
        status: "accepted" as const,
        threadId: "thread-1",
        messageId: "message-1",
      };
      let events = createGatewayEventStore({ file });
      events.rememberRequest(
        key,
        `{"input":{"environmentId":"local","idempotencyKey":"verified-historical-send","text":"Already stored","threadId":"thread-1"},"operation":"message.send"}`,
        null,
      );
      if (state === "completed") events.completeRequest(key, receipt);
      else {
        events.markRequestDispatched(key, {
          requestId: historicalRequestId,
          messageId: "message-1",
        });
      }
      events.close();

      const sends: string[] = [];
      const hasThreadMessageCalls: Array<ReadonlyArray<string>> = [];
      const port = makePort();
      port.getThread = async () => ({ id: "thread-1", messages: [] });
      port.hasThreadMessage = async (...args) => {
        hasThreadMessageCalls.push(args);
        return true;
      };
      port.sendMessage = async (request) => {
        sends.push(request.requestId);
        return receipt;
      };
      events = createGatewayEventStore({ file });
      await expect(
        callGatewayTool({ port, grants, events }, "t3_send_message", input),
      ).resolves.toEqual(receipt);
      expect(hasThreadMessageCalls).toEqual([["local", "thread-1", "message-1"]]);
      expect(sends).toEqual(state === "dispatched" ? [historicalRequestId] : []);
      events.close();

      events = createGatewayEventStore({ file });
      await expect(
        callGatewayTool({ port, grants, events }, "t3_send_message", input),
      ).resolves.toEqual(receipt);
      expect(sends).toEqual(state === "dispatched" ? [historicalRequestId] : []);
      events.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  );

  it("replays a resolved label-only profile without re-reading the mutable catalog", async () => {
    const creates: Array<{ model: string; runtimeMode: string }> = [];
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile-andy",
        name: "Andy",
        revision: 1,
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Sol",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    ];
    const port = makePort({ creates, profiles });
    let resolutions = 0;
    port.resolveProfileModelSelection = async () => {
      resolutions += 1;
      if (resolutions > 1) throw new Error("catalog unavailable");
      return { instanceId: "codex", model: "gpt-5.6-sol" };
    };
    const context = { port, grants, events: createGatewayEventStore() };
    const request = {
      environmentId: "local",
      projectId: "local-project",
      title: "Idempotent profile chat",
      profile: "Andy",
      idempotencyKey: "create-profile-idem-1",
    };

    const first = await callGatewayTool(context, "t3_create_thread", request);
    const second = await callGatewayTool(context, "t3_create_thread", request);

    expect(second).toEqual(first);
    expect(resolutions).toBe(1);
    expect(creates).toHaveLength(1);
  });

  it("recovers an ambiguous upstream receipt without repeating the server side effect", async () => {
    const events = createGatewayEventStore();
    let effects = 0;
    let committedRequestId: string | undefined;
    const port = makePort();
    port.sendMessage = async (request) => {
      if (committedRequestId === undefined) {
        committedRequestId = request.requestId;
        effects += 1;
        throw new Error("transport closed after commit");
      }
      expect(request.requestId).toBe(committedRequestId);
      return {
        requestId: committedRequestId,
        commandId: committedRequestId,
        status: "accepted",
        threadId: request.threadId,
        messageId: request.messageId,
      };
    };
    const context = { port, grants, events };
    const request = {
      environmentId: "local",
      threadId: "thread-1",
      text: "Run once",
      idempotencyKey: "ambiguous-send-1",
    };

    await expect(callGatewayTool(context, "t3_send_message", request)).rejects.toThrow(
      "transport closed after commit",
    );
    await expect(callGatewayTool(context, "t3_send_message", request)).resolves.toMatchObject({
      status: "accepted",
      commandId: expect.stringMatching(/^mcp-message-send-v2-/u),
    });
    expect(effects).toBe(1);
  });

  it("reports idempotency_conflict when the same key carries a different payload", async () => {
    const creates: Array<{ model: string; runtimeMode?: string; reasoningEffort?: string }> = [];
    const events = createGatewayEventStore();
    const context = { port: makePort({ creates }), grants, events };
    const base = {
      environmentId: "local",
      projectId: "local-project",
      title: "Conflict chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: "create-conflict-1",
    };
    await callGatewayTool(context, "t3_create_thread", base);
    await expect(
      callGatewayTool(context, "t3_create_thread", { ...base, title: "Different chat" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("emits lifecycle events and serves replay with cursors and acks", async () => {
    const events = createGatewayEventStore({ now: () => "2026-09-04T00:00:02.000Z" });
    const context = { port: makePort(), grants, events };

    const created = await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Event chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: "event-create-1",
    });
    await callGatewayTool(context, "t3_control_thread", {
      environmentId: "local",
      threadId: created.threadId,
      action: "stop",
      idempotencyKey: "event-stop-1",
    });
    expect(events.latestSequence("local")).toBe(0);
    events.ingest({
      environmentId: "local",
      eventId: "server-event-1",
      sequence: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      type: "thread.started",
      threadId: created.threadId as string,
    });
    events.ingest({
      environmentId: "local",
      eventId: "server-event-2",
      sequence: 2,
      occurredAt: "2026-09-04T00:00:01.000Z",
      type: "thread.state_changed",
      threadId: created.threadId as string,
    });

    const replay = await callGatewayTool(context, "t3_get_events", {
      environmentId: "local",
      afterSequence: 0,
    });
    expect(replay.items.map((event: { type: string }) => event.type)).toEqual([
      "thread.started",
      "thread.state_changed",
    ]);
    expect(replay.latestSequence).toBe(2);

    const subscription = (await callGatewayTool(context, "t3_subscribe_events", {
      environmentId: "local",
      afterSequence: replay.latestSequence,
    })) as { subscriptionId: string; ackedSequence: number };
    expect(subscription.ackedSequence).toBe(2);

    const acked = await callGatewayTool(context, "t3_ack_events", {
      environmentId: "local",
      subscriptionId: subscription.subscriptionId,
      throughSequence: replay.latestSequence,
    });
    expect(acked).toEqual({ subscriptionId: subscription.subscriptionId, ackedSequence: 2 });
    await expect(
      callGatewayTool(context, "t3_ack_events", {
        environmentId: "local",
        subscriptionId: subscription.subscriptionId,
        throughSequence: 999,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // Cursor replay honours afterSequence.
    const tail = await callGatewayTool(context, "t3_get_events", {
      environmentId: "local",
      afterSequence: 1,
    });
    expect(tail.items.map((event: { type: string }) => event.type)).toEqual([
      "thread.state_changed",
    ]);
  });

  it("requires read and delivery scopes for webhook registration", async () => {
    const events = createGatewayEventStore();
    await expect(
      callGatewayTool(
        { port: makePort(), grants: { local: ["delivery"] }, events },
        "t3_register_webhook",
        { environmentId: "local", url: "https://example.com/hook" },
      ),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(events.listWebhooks("local")).toEqual([]);
  });

  it("registers, lists, and deletes webhooks without ever re-serving the secret", async () => {
    const events = createGatewayEventStore();
    const context = { port: makePort(), grants, events };

    const registered = (await callGatewayTool(context, "t3_register_webhook", {
      environmentId: "local",
      url: "https://example.com/hook",
      types: ["thread.completed"],
    })) as { webhookId: string; secret: string; secretReference: string };
    expect(registered.secret).not.toBe("");
    expect(registered.secretReference).toBe(`webhook-secret/${registered.webhookId}`);

    const listed = (await callGatewayTool(context, "t3_list_webhooks", {
      environmentId: "local",
    })) as { items: Array<{ secret: string }> };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.secret).toBe("");

    await expect(
      callGatewayTool(context, "t3_register_webhook", {
        environmentId: "local",
        url: "http://example.com/hook",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const deleted = await callGatewayTool(context, "t3_delete_webhook", {
      environmentId: "local",
      webhookId: registered.webhookId,
    });
    expect(deleted).toEqual({ deleted: true });
    expect(
      (await callGatewayTool(context, "t3_list_webhooks", { environmentId: "local" })) as {
        items: unknown[];
      },
    ).toEqual({ items: [] });
  });

  it("requires an event store for delivery tools", async () => {
    await expect(
      callGatewayTool({ port: makePort(), grants }, "t3_subscribe_events", {
        environmentId: "local",
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("reports presence from the host and requires read scope", async () => {
    const presence = {
      environmentId: "local",
      present: true,
      anyVisible: true,
      anyFocused: false,
      anyRecentlyInteracted: false,
      lastActivityAt: "2026-10-23T07:00:00.000Z",
      clients: [],
      observedAt: "2026-10-23T07:00:10.000Z",
    };
    const requested: Array<string> = [];
    const port = {
      ...makePort(),
      getPresence: async (environmentId: string) => {
        requested.push(environmentId);
        return presence;
      },
    };
    await expect(
      callGatewayTool({ port, grants }, "t3_get_presence", { environmentId: "local" }),
    ).resolves.toEqual(presence);
    await expect(
      callGatewayTool({ port, grants: { local: ["send"] as const } }, "t3_get_presence", {
        environmentId: "local",
      }),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(requested).toEqual(["local"]);
  });

  it("reports degraded bridge health instead of claiming a healthy connection", async () => {
    const health = await callGatewayTool(
      {
        port: makePort(),
        grants,
        health: () => ({ bridge: "degraded", degradedReasons: ["bridge address in use"] }),
      },
      "t3_get_gateway_health",
      {},
    );

    expect(health).toMatchObject({
      health: "degraded",
      mcpTransport: "connected",
      bridge: "degraded",
      degradedReasons: ["bridge address in use"],
    });
  });

  it("reports exhausted webhook retries through degraded gateway health", async () => {
    const events = createGatewayEventStore({ webhookRetryBaseMs: 0 });
    const { webhook } = events.registerWebhook({
      environmentId: "local",
      url: "https://example.com/hook",
    });
    const event = events.emit({ environmentId: "local", type: "thread.completed" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(events.buildDelivery(webhook.webhookId, event.eventId)).toBeDefined();
      events.reportDeliveryAttempt(
        webhook.webhookId,
        event.eventId,
        { ok: false, retryable: true },
        "receiver unavailable",
      );
    }

    const health = await callGatewayTool(
      { port: makePort(), grants, events },
      "t3_get_gateway_health",
      {},
    );

    expect(health).toMatchObject({
      health: "degraded",
      eventStore: "degraded",
      deliveryFailureCount: 1,
      degradedReasons: [expect.stringContaining("receiver unavailable")],
    });
    events.close();
  });

  it("removes approvals that the canonical server marked stale", async () => {
    const summary = await callGatewayTool(
      {
        port: makePort({ pendingApprovalPlan: true, staleApprovalPlan: true }),
        grants,
      },
      "t3_summarize_thread",
      { environmentId: "local", threadId: "thread-1" },
    );
    const plan = (summary as { approvalPlan: unknown }).approvalPlan;

    expect(plan).toMatchObject({ revision: 11 });
    expect((plan as { actions: Array<{ approvalActionId: string }> }).actions).toEqual([
      expect.objectContaining({ approvalActionId: "approval-2" }),
    ]);
  });

  it("reclaims worktrees only with lifecycle scope, while a dry run needs read", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    const context = { port: makePort({ operations }), grants: { local: ["read"] } as const };
    const input = { environmentId: "local", threadId: "finished-task" };
    await expect(callGatewayTool(context, "t3_reclaim_worktree", input)).rejects.toMatchObject({
      code: "scope_required",
    });
    expect(operations).toEqual([]);
    await callGatewayTool(context, "t3_reclaim_worktree", { ...input, dryRun: true });
    await callGatewayTool(
      { port: makePort({ operations }), grants: { local: ["lifecycle"] } },
      "t3_reclaim_worktree",
      input,
    );
    expect(operations).toEqual([
      { operation: "worktree.reclaim", payload: { ...input, dryRun: true } },
      { operation: "worktree.reclaim", payload: input },
    ]);
  });

  it("does not let the legacy control scope authorize repository writes", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    await expect(
      callGatewayTool(
        { port: makePort({ operations }), grants: { local: ["control"] } },
        "t3_apply_patch",
        {
          environmentId: "local",
          projectId: "local-project",
          patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
          idempotencyKey: "patch-control-only",
        },
      ),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(operations).toEqual([]);
  });

  it("rejects patch paths outside the selected project root", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    await expect(
      callGatewayTool({ port: makePort({ operations }), grants }, "t3_apply_patch", {
        environmentId: "local",
        projectId: "local-project",
        patch: "--- a/README.md\n+++ ../../outside\n@@ -1 +1 @@\n-old\n+new\n",
        idempotencyKey: "patch-escape",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(operations).toEqual([]);
  });

  it("rejects upstream repository writes even when the selected project matches", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    await expect(
      callGatewayTool(
        { port: makePort({ operations, projectOwner: "pingdotgg" }), grants },
        "t3_create_pr",
        {
          environmentId: "local",
          projectId: "local-project",
          owner: "pingdotgg",
          repository: "t3code",
          headBranch: "feature/test",
          baseBranch: "main",
          title: "Unsafe upstream write",
          idempotencyKey: "pr-upstream",
        },
      ),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(operations).toEqual([]);
  });

  it("rejects pull requests targeting a different repository owner", async () => {
    await expect(
      callGatewayTool({ port: makePort({ projectOwner: "jayleaton" }), grants }, "t3_create_pr", {
        environmentId: "local",
        projectId: "local-project",
        owner: "fork-owner",
        repository: "t3code",
        headBranch: "feature/test",
        baseBranch: "main",
        title: "Test",
        idempotencyKey: "pr-fork",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("routes v3 write tools through the runtime operation boundary idempotently", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    const events = createGatewayEventStore();
    const context = { port: makePort({ operations }), grants, events };
    const input = {
      environmentId: "local",
      projectId: "local-project",
      repository: "jayleaton/t3code",
      number: 12,
      title: "Updated",
      idempotencyKey: "update-pr-1",
    };

    const first = await callGatewayTool(context, "t3_update_pr", input);
    const second = await callGatewayTool(context, "t3_update_pr", input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ requestId: expect.stringMatching(/^mcp-operation-v2-/u) });
    expect(operations).toEqual([{ operation: "pr.update", payload: input }]);
  });
});

describe("gateway v3 profile selection", () => {
  it("carries profile identity, revision, and resolved routing to the authoritative server", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile_andy",
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        reasoningEffort: "medium",
        runtimeMode: "full-access",
        interactionMode: "default",
        revision: 3,
      },
    ];
    const port = makePort({ profiles });
    const original = port.createThread.bind(port);
    port.createThread = async (request) => {
      creates.push(request as unknown as Record<string, unknown>);
      return original(request);
    };
    const context = { port, grants, profiles };

    await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Snapshot chat",
      profileId: "profile_andy",
      idempotencyKey: "snapshot-create-1",
    });

    expect(creates[0]).toMatchObject({
      modelSelection: {
        instanceId: "glm",
        model: "glm-5.3",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      profileSelection: {
        profileId: "profile_andy",
        revision: 3,
        overrideFields: [],
      },
    });
    expect(creates[0]).not.toHaveProperty("profileSnapshot");
  });

  it("does not synthesize a caller-owned profile snapshot when no profile applies", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const port = makePort();
    const original = port.createThread.bind(port);
    port.createThread = async (request) => {
      creates.push(request as unknown as Record<string, unknown>);
      return original(request);
    };
    await callGatewayTool({ port, grants }, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Fallback chat",
      idempotencyKey: "fallback-create-1",
    });
    expect(creates[0]).not.toHaveProperty("profileSnapshot");
    expect(creates[0]).not.toHaveProperty("profileSelection");
    expect(creates[0]).not.toHaveProperty("modelSelection");
  });
});

describe("gateway v3 readable profiles", () => {
  it("surfaces readable labels on t3_list_agents without requiring routing keys", async () => {
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile_andy",
        name: "Andy",
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Sol",
        reasoningEffort: "medium",
        runtimeMode: "full-access",
        interactionMode: "default",
        revision: 1,
      },
    ];
    const listed = await callGatewayTool(
      { port: makePort({ profiles }), grants, profiles },
      "t3_list_agents",
      { environmentId: "local" },
    );
    expect(listed.items).toEqual([
      expect.objectContaining({
        name: "Andy",
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Sol",
      }),
    ]);
  });

  it("creates a thread from a Settings label-only profile using transient routing", async () => {
    const creates: Array<{
      instanceId?: string;
      model: string;
      runtimeMode: string;
      reasoningEffort?: string;
      profileId?: string;
    }> = [];
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile_andy",
        name: "Andy",
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Sol",
        runtimeMode: "approval-required",
        interactionMode: "default",
        revision: 1,
      },
    ];

    await expect(
      callGatewayTool(
        { port: makePort({ profiles, creates }), grants, profiles },
        "t3_create_thread",
        {
          environmentId: "local",
          projectId: "local-project",
          title: "Resolved profile chat",
          profileId: "profile_andy",
          idempotencyKey: "label-only-create-1",
        },
      ),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(creates).toEqual([
      expect.objectContaining({ instanceId: "codex", model: "gpt-5.6-sol" }),
    ]);
  });

  it("rejects a disappeared or ambiguous label pair using readable text", async () => {
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile_andy",
        name: "Andy",
        providerLabel: "Missing Codex",
        modelLabel: "Missing GPT",
        runtimeMode: "approval-required",
        interactionMode: "default",
        revision: 1,
      },
    ];
    await expect(
      callGatewayTool({ port: makePort({ profiles }), grants, profiles }, "t3_create_thread", {
        environmentId: "local",
        projectId: "local-project",
        title: "Resolved profile chat",
        profileId: "profile_andy",
        idempotencyKey: "label-only-create-2",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("provider: Missing Codex, model: Missing GPT"),
    });
  });
});

describe("agent profile tools", () => {
  function profilesPort() {
    let profiles: GatewayProfile[] = [];
    const port: GatewayRuntimePort = {
      ...makePort(),
      listProfiles: async () => profiles,
      createProfile: vi.fn(async (_environmentId, input) => {
        const profile = { ...input, profileId: "write", revision: 1 };
        profiles = [...profiles, profile];
        return profile;
      }),
      updateProfile: vi.fn(async (_environmentId, id, patch) => {
        const current = profiles.find((profile) => profile.profileId === id)!;
        const profile = {
          ...current,
          ...patch,
          revision: (current.revision ?? 0) + 1,
        } as GatewayProfile;
        profiles = profiles.map((item) => (item.profileId === id ? profile : item));
        return profile;
      }),
      deleteProfile: vi.fn(async (_environmentId, id) => {
        profiles = profiles.filter((profile) => profile.profileId !== id);
        return { profileId: id, status: "succeeded" as const };
      }),
      replicateProfiles: vi.fn(async () => {}),
      openAgents: vi.fn(async () => ({ status: "succeeded" as const })),
    };
    return port;
  }
  const input = {
    environmentId: "local",
    name: "Write",
    providerLabel: "OpenCode",
    modelLabel: "GLM Flash",
    runtimeMode: "approval-required",
    interactionMode: "default",
  };

  it("creates, lists, updates, and clears a specialization without changing instructions", async () => {
    const port = profilesPort();
    const context = { port, grants: { local: ["admin", "read"] } as const };
    await callGatewayTool(context, "t3_create_agent", {
      ...input,
      description: "Reviews security",
      systemPrompt: "Report vulnerabilities",
    });
    expect(
      await callGatewayTool(context, "t3_list_agents", { environmentId: "local" }),
    ).toMatchObject({ items: [{ description: "Reviews security" }] });
    await callGatewayTool(context, "t3_update_agent", {
      environmentId: "local",
      profileId: "write",
      patch: { description: "" },
    });
    expect(await port.listProfiles!("local")).toMatchObject([
      { description: "", systemPrompt: "Report vulnerabilities" },
    ]);
    await expect(
      callGatewayTool(context, "t3_update_agent", {
        environmentId: "local",
        profileId: "write",
        patch: { description: "x".repeat(281) },
      }),
    ).rejects.toThrow();
  });

  it("agent tools share one library without starting a thread", async () => {
    const port = profilesPort();
    const createThread = vi.spyOn(port, "createThread");
    const context = { port, grants: { local: ["create"], remote: ["read"] } as const };
    const created = await callGatewayTool(context, "t3_create_agent", input);
    expect(created).toMatchObject({
      profile: { profileId: "write", revision: 1, providerLabel: "OpenCode" },
    });
    expect(port.replicateProfiles).not.toHaveBeenCalled();
    const shared = { port, grants: { local: ["admin"], remote: ["create"] } as const };
    expect(
      await callGatewayTool(shared, "t3_update_agent", {
        environmentId: "local",
        profileId: "write",
        patch: { providerLabel: "Codex", modelLabel: "GPT" },
      }),
    ).toMatchObject({ profile: { revision: 2, providerLabel: "Codex" } });
    expect(port.replicateProfiles).toHaveBeenCalledWith("remote", [
      expect.objectContaining({ profileId: "write", revision: 2 }),
    ]);
    await callGatewayTool(shared, "t3_delete_agent", {
      environmentId: "local",
      profileId: "write",
    });
    expect(port.replicateProfiles).toHaveBeenLastCalledWith("remote", []);
    expect(createThread).not.toHaveBeenCalled();
  });

  it("sets and clears an agent's icon and role tags", async () => {
    const port = profilesPort();
    const context = { port, grants: { local: ["create"] } as const };
    await callGatewayTool(context, "t3_create_agent", {
      ...input,
      iconId: "rocket",
      tags: ["Dev", "Ops"],
    });
    expect(await port.listProfiles!("local")).toMatchObject([
      { iconId: "rocket", tags: ["Dev", "Ops"] },
    ]);
    await callGatewayTool(context, "t3_update_agent", {
      environmentId: "local",
      profileId: "write",
      patch: { tags: [] },
    });
    expect(await port.listProfiles!("local")).toMatchObject([{ iconId: "rocket", tags: [] }]);
    await expect(
      callGatewayTool(context, "t3_update_agent", {
        environmentId: "local",
        profileId: "write",
        patch: { iconId: "not-an-icon" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unauthorized or malformed edits before writing", async () => {
    const port = profilesPort();
    await expect(
      callGatewayTool({ port, grants: { local: ["read"] } }, "t3_create_agent", input),
    ).rejects.toMatchObject({ code: "scope_required" });
    await expect(
      callGatewayTool({ port, grants: { local: ["create"] } }, "t3_update_agent", {
        environmentId: "local",
        profileId: "write",
        patch: { revision: 900 },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(port.createProfile).not.toHaveBeenCalled();
    expect(port.updateProfile).not.toHaveBeenCalled();
  });

  it("reports partial sync failure without pretending the source save failed", async () => {
    const port = profilesPort();
    port.replicateProfiles = async () => {
      throw new Error("offline");
    };
    expect(
      await callGatewayTool(
        { port, grants: { local: ["create"], remote: ["create"] } },
        "t3_create_agent",
        input,
      ),
    ).toMatchObject({
      profile: { profileId: "write" },
      sync: { failedEnvironmentIds: ["remote"] },
    });
  });

  it("filters thread lists by both project and profile and scopes desktop navigation", async () => {
    const port = profilesPort();
    port.listThreads = async () => ({
      snapshotAt: "now",
      items: [
        { id: "match", projectId: "p", profileSnapshot: { profileId: "write" } },
        { id: "other-project", projectId: "q", profileSnapshot: { profileId: "write" } },
        { id: "other-agent", projectId: "p", profileSnapshot: { profileId: "review" } },
        { id: "no-agent", projectId: "p" },
      ],
    });
    const context = { port, grants: { local: ["read"] } as const };
    expect(
      await callGatewayTool(context, "t3_list_threads", {
        environmentId: "local",
        projectId: "p",
        profileId: "write",
      }),
    ).toMatchObject({ items: [{ id: "match" }] });
    await callGatewayTool(context, "t3_open_agents", { environmentId: "local" });
    expect(port.openAgents).toHaveBeenCalledWith("local");
    await expect(
      callGatewayTool({ port, grants: {} }, "t3_open_agents", { environmentId: "local" }),
    ).rejects.toMatchObject({ code: "unknown_environment" });
  });

  it("keeps system prompts out of agent listings unless asked", async () => {
    const port = profilesPort();
    const context = { port, grants: { local: ["admin", "read"] } as const };
    await callGatewayTool(context, "t3_create_agent", { ...input, systemPrompt: "Long prompt" });

    const agents = await callGatewayTool(context, "t3_list_agents", { environmentId: "local" });
    expect(agents).toMatchObject({ items: [{ profileId: "write", name: "Write" }] });
    expect(JSON.stringify(agents)).not.toContain("Long prompt");
    expect(
      await callGatewayTool(context, "t3_list_agents", {
        environmentId: "local",
        includeSystemPrompt: true,
      }),
    ).toMatchObject({ items: [{ systemPrompt: "Long prompt" }] });
  });
});

describe("agent handoff permissions", () => {
  const input = {
    sourceEnvironmentId: "source",
    sourceThreadId: "plan",
    environmentId: "target",
    projectId: "project",
    profileId: "code",
    handoffId: "018e1000-0000-4000-8000-000000000001",
    title: "Code",
    summary: "Plan",
    prompt: "Implement",
    files: ["plan.md"],
  };
  it("requires source artifact access and target create, send, and artifact access before transferring", async () => {
    const port = makePort();
    port.handoffThread = vi.fn(async () => ({
      environmentId: "target",
      threadId: "new",
      briefPath: "brief.md",
      status: "sent" as const,
      sourceSettlement: "confirmation-required" as const,
    }));
    await expect(
      callGatewayTool(
        { port, grants: { source: ["read"], target: ["create", "send", "artifact"] } },
        "t3_handoff_thread",
        input,
      ),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(port.handoffThread).not.toHaveBeenCalled();
    await callGatewayTool(
      { port, grants: { source: ["read", "artifact"], target: ["create", "send", "artifact"] } },
      "t3_handoff_thread",
      input,
    );
    expect(port.handoffThread).toHaveBeenCalledWith(input);
  });
  it("requires a separate confirmed settlement call", async () => {
    const port = makePort();
    port.settleThread = vi.fn(async () => ({ status: "succeeded" as const }));
    const context = { port, grants: { source: ["lifecycle"] } as const };
    await expect(
      callGatewayTool(context, "t3_settle_thread", { environmentId: "source", threadId: "plan" }),
    ).rejects.toThrow("Ask the user");
    expect(port.settleThread).not.toHaveBeenCalled();
    await callGatewayTool(context, "t3_settle_thread", {
      environmentId: "source",
      threadId: "plan",
      confirmed: true,
    });
    expect(port.settleThread).toHaveBeenCalledWith("source", "plan");
  });
});

describe("agent chat lifecycle", () => {
  it("filters active and settled chats within the selected project and agent", async () => {
    const port = makePort();
    port.listThreads = async () => ({
      snapshotAt: "now",
      items: [
        {
          id: "active",
          projectId: "project",
          profileSnapshot: { profileId: "code" },
          settledAt: null,
        },
        {
          id: "done",
          projectId: "project",
          profileSnapshot: { profileId: "code" },
          settledAt: "2026-09-07T00:00:00.000Z",
        },
        {
          id: "other-agent",
          projectId: "project",
          profileSnapshot: { profileId: "review" },
          settledAt: null,
        },
        {
          id: "other-project",
          projectId: "elsewhere",
          profileSnapshot: { profileId: "code" },
          settledAt: null,
        },
      ],
    });
    const context = { port, grants: { local: ["read"] } as const };
    const input = { environmentId: "local", projectId: "project", profileId: "code" };
    expect(
      await callGatewayTool(context, "t3_list_threads", { ...input, state: "active" }),
    ).toMatchObject({ items: [{ id: "active" }] });
    expect(
      await callGatewayTool(context, "t3_list_threads", { ...input, state: "settled" }),
    ).toMatchObject({ items: [{ id: "done" }] });
    expect(await callGatewayTool(context, "t3_list_threads", input)).toMatchObject({
      items: [{ id: "active" }, { id: "done" }],
    });
    await expect(
      callGatewayTool(context, "t3_list_threads", { ...input, state: "invalid" }),
    ).rejects.toThrow();
  });
  it("requires lifecycle access to un-settle and routes to the owning environment", async () => {
    const port = makePort();
    port.unsettleThread = vi.fn(async () => ({ status: "succeeded" as const }));
    const input = { environmentId: "remote", threadId: "done" };
    await expect(
      callGatewayTool({ port, grants: { remote: ["read"] } }, "t3_unsettle_thread", input),
    ).rejects.toThrow();
    expect(port.unsettleThread).not.toHaveBeenCalled();
    await expect(
      callGatewayTool({ port, grants: { remote: ["lifecycle"] } }, "t3_unsettle_thread", input),
    ).resolves.toEqual({ status: "succeeded" });
    expect(port.unsettleThread).toHaveBeenCalledWith("remote", "done");
  });
  it("links and detaches chats with lifecycle access", async () => {
    const port = makePort();
    port.setThreadParent = vi.fn(async () => ({ status: "succeeded" as const }));
    const link = { environmentId: "remote", threadId: "child", parentThreadId: "parent" };
    await expect(
      callGatewayTool({ port, grants: { remote: ["read"] } }, "t3_set_thread_parent", link),
    ).rejects.toThrow();
    expect(port.setThreadParent).not.toHaveBeenCalled();
    const context = { port, grants: { remote: ["lifecycle"] as const } };
    await expect(callGatewayTool(context, "t3_set_thread_parent", link)).resolves.toEqual({
      status: "succeeded",
    });
    await callGatewayTool(context, "t3_set_thread_parent", { ...link, parentThreadId: null });
    expect(port.setThreadParent).toHaveBeenNthCalledWith(1, "remote", "child", "parent");
    expect(port.setThreadParent).toHaveBeenNthCalledWith(2, "remote", "child", null);
  });
});

describe("MCP Agents board", () => {
  const profiles: GatewayProfile[] = [
    {
      profileId: "review",
      name: "Reviewer",
      description: "Finds bugs",
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
    {
      profileId: "write",
      name: "Writer",
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
  ];
  const runs = [
    {
      id: "running",
      title: "Review PR",
      projectId: "p1",
      profileSnapshot: { profileId: "review" },
      status: "running",
      settledAt: null,
    },
    {
      id: "finished",
      profileSnapshot: { profileId: "review" },
      status: "completed",
      settledAt: "2026-09-13",
    },
    {
      id: "deleted-agent",
      profileSnapshot: { profileId: "deleted" },
      status: "idle",
      settledAt: null,
    },
    { id: "normal-thread", profileSnapshot: null, status: "running", settledAt: null },
  ];
  function context() {
    const port = {
      ...makePort({ profiles }),
      listThreads: vi.fn(async () => ({ items: runs, snapshotAt: "now" })),
    };
    return { port, grants: { local: ["read"] } as const };
  }
  it("groups only agent chats with descriptions and preserves deleted-agent runs", async () => {
    const result = await callGatewayTool(context(), "t3_get_agents_view", {
      environmentId: "local",
    });
    expect(result).toMatchObject({
      environmentId: "local",
      snapshotAt: "now",
      items: [
        {
          profileId: "review",
          description: "Finds bugs",
          runs: [
            { threadId: "running", projectId: "p1", status: "running", environmentId: "local" },
          ],
        },
        { profileId: "write", description: "", runs: [] },
      ],
      orphanedRuns: [{ threadId: "deleted-agent", profileId: "deleted" }],
    });
    expect(JSON.stringify(result)).not.toContain("normal-thread");
    expect(JSON.stringify(result)).not.toContain("finished");
  });
  it("filters by agent and settled state", async () => {
    expect(
      await callGatewayTool(context(), "t3_get_agents_view", {
        environmentId: "local",
        profileId: "review",
        state: "settled",
      }),
    ).toMatchObject({
      items: [{ profileId: "review", runs: [{ threadId: "finished" }] }],
      orphanedRuns: [],
    });
    const result = await callGatewayTool(context(), "t3_get_agents_view", {
      environmentId: "local",
      profileId: "review",
      state: "all",
    });
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("running");
    expect(JSON.stringify(result)).toContain("finished");
  });
  it("checks read grants before loading runs from a machine", async () => {
    const ctx = context();
    await expect(
      callGatewayTool(ctx, "t3_get_agents_view", { environmentId: "remote" }),
    ).rejects.toMatchObject({ code: "unknown_environment" });
    expect(ctx.port.listThreads).not.toHaveBeenCalled();
    await expect(
      callGatewayTool(ctx, "t3_get_agents_view", { environmentId: "local", state: "invalid" }),
    ).rejects.toThrow();
  });
});

describe("gateway coordinator operations", () => {
  const readGrants = { local: ["read"] } as const;

  it("filters chats by explicit execution state while preserving active/settled meaning", async () => {
    const port = makePort();
    port.listThreads = async () => ({
      snapshotAt: "now",
      items: [
        { id: "running", settledAt: null, status: "running", updatedAt: "2026-09-07T03:00:00Z" },
        {
          id: "waiting",
          settledAt: null,
          status: "waiting-input",
          updatedAt: "2026-09-07T02:00:00Z",
        },
        {
          id: "completed",
          settledAt: null,
          status: "completed",
          updatedAt: "2026-09-07T01:00:00Z",
        },
        {
          id: "settled-done",
          projectId: "p",
          settledAt: "2026-09-07T00:00:00.000Z",
          status: "completed",
        },
      ],
    });
    const context = { port, grants: readGrants };
    expect(
      await callGatewayTool(context, "t3_list_threads", {
        environmentId: "local",
        state: "active",
        executionState: "running",
      }),
    ).toMatchObject({ items: [{ id: "running" }] });
    expect(
      await callGatewayTool(context, "t3_list_threads", {
        environmentId: "local",
        state: "active",
        executionState: "waiting-input",
      }),
    ).toMatchObject({ items: [{ id: "waiting" }] });
    // state=active keeps its unsettled meaning and still includes completed chats.
    expect(
      await callGatewayTool(context, "t3_list_threads", {
        environmentId: "local",
        state: "active",
      }),
    ).toMatchObject({ items: [{ id: "running" }, { id: "waiting" }, { id: "completed" }] });
    await expect(
      callGatewayTool(context, "t3_list_threads", {
        environmentId: "local",
        executionState: "bogus",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("filters the Agents board by execution state", async () => {
    const profiles: GatewayProfile[] = [
      {
        profileId: "review",
        name: "Reviewer",
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    ];
    const port = {
      ...makePort({ profiles }),
      listThreads: vi.fn(async () => ({
        snapshotAt: "now",
        items: [
          {
            id: "running",
            profileSnapshot: { profileId: "review" },
            status: "running",
            settledAt: null,
          },
          {
            id: "blocked",
            profileSnapshot: { profileId: "review" },
            status: "waiting-approval",
            settledAt: null,
          },
        ],
      })),
    };
    const result = await callGatewayTool({ port, grants: readGrants }, "t3_get_agents_view", {
      environmentId: "local",
      executionState: "waiting-approval",
    });
    expect(result).toMatchObject({
      items: [{ profileId: "review", runs: [{ threadId: "blocked" }] }],
    });
  });

  it("creates and starts a chat idempotently and reports both phases", async () => {
    const port = makePort();
    const createThread = vi.spyOn(port, "createThread");
    const sendMessage = vi.spyOn(port, "sendMessage");
    const events = createGatewayEventStore();
    const context = { port, grants, events };
    const request = {
      environmentId: "local",
      projectId: "local-project",
      title: "Start work",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      text: "Run the checks",
      idempotencyKey: "start-1",
    };

    const first = await callGatewayTool(context, "t3_create_and_start_thread", request);
    expect(first).toMatchObject({
      status: "started",
      partial: false,
      retryable: false,
      creation: { status: "accepted" },
      message: { status: "accepted" },
    });
    expect(first.threadId).toMatch(/^mcp-thread-v2-/u);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const second = await callGatewayTool(context, "t3_create_and_start_thread", request);
    expect(second.threadId).toBe(first.threadId);
    expect(second.message.messageId).toBe(first.message.messageId);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps a partial create-and-start inspectable and retryable without duplicating the chat", async () => {
    const port = makePort();
    const createThread = vi.spyOn(port, "createThread");
    let failSend = true;
    const sendMessage = vi.spyOn(port, "sendMessage").mockImplementation(async (request) => {
      if (failSend) throw new Error("bridge offline");
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted" as const,
        threadId: request.threadId,
        messageId: request.messageId,
      };
    });
    const events = createGatewayEventStore();
    const context = { port, grants, events };
    const request = {
      environmentId: "local",
      projectId: "local-project",
      title: "Start work",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      text: "Run",
      idempotencyKey: "start-partial",
    };

    const partial = await callGatewayTool(context, "t3_create_and_start_thread", request);
    expect(partial).toMatchObject({
      status: "partial",
      partial: true,
      retryable: true,
      message: null,
      error: { code: "upstream_failure" },
    });
    expect(partial.threadId).toMatch(/^mcp-thread-v2-/u);

    failSend = false;
    const retried = await callGatewayTool(context, "t3_create_and_start_thread", request);
    expect(retried).toMatchObject({
      status: "started",
      partial: false,
      threadId: partial.threadId,
    });
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("waits for a chat to reach a requested status and returns a resumable cursor", async () => {
    const events = createGatewayEventStore();
    let status = "running";
    const baselineRead = Promise.withResolvers<void>();
    const port = {
      ...makePort(),
      listThreads: async () => {
        const items = [{ id: "chat-1", projectId: "p", title: "Chat", status, settledAt: null }];
        baselineRead.resolve();
        return { snapshotAt: "now", items };
      },
    };
    const context = { port, grants: readGrants, events };
    const wait = callGatewayTool(context, "t3_wait_for_thread_status", {
      environmentId: "local",
      threadId: "chat-1",
      untilStatuses: ["completed"],
      timeoutMs: 1_000,
    });
    // The wait replays events after its starting cursor, so only the baseline must see "running".
    await baselineRead.promise;
    status = "completed";
    const event = events.emit({
      environmentId: "local",
      threadId: "chat-1",
      type: "thread.completed",
      data: { status: "completed" },
    });

    await expect(wait).resolves.toMatchObject({
      status: "completed",
      previousStatus: "running",
      changed: true,
      matched: true,
      timedOut: false,
      cursor: event.sequence,
      thread: { id: "chat-1", status: "completed" },
    });
  });

  it("resumes from the cursor status when completion happens between calls", async () => {
    const events = createGatewayEventStore();
    let status = "running";
    const port = {
      ...makePort(),
      listThreads: async () => ({ snapshotAt: "now", items: [{ id: "chat-1", status }] }),
    };
    const context = { port, grants: readGrants, events };
    const running = events.emit({
      environmentId: "local",
      threadId: "chat-1",
      type: "thread.started",
      data: { status },
    });
    const request = { environmentId: "local", threadId: "chat-1", timeoutMs: 250 };
    try {
      const first = await callGatewayTool(context, "t3_wait_for_thread_status", {
        ...request,
        untilStatuses: ["running"],
      });
      expect(first.cursor).toBe(running.sequence);
      status = "completed";
      const completed = events.emit({
        environmentId: "local",
        threadId: "chat-1",
        type: "thread.completed",
        data: { status },
      });
      // Other chats and events without a status must not become the baseline.
      events.emit({ environmentId: "local", threadId: "other", type: "thread.failed" });
      expect(
        await callGatewayTool(context, "t3_wait_for_thread_status", {
          ...request,
          afterSequence: first.cursor,
        }),
      ).toMatchObject({
        previousStatus: "running",
        status: "completed",
        changed: true,
        matched: true,
        timedOut: false,
        lastEvent: { sequence: completed.sequence },
      });
      const cursor = events.emit({
        environmentId: "local",
        threadId: "chat-1",
        type: "thread.progress",
      }).sequence;
      expect(
        await callGatewayTool(context, "t3_wait_for_thread_status", {
          ...request,
          afterSequence: cursor,
        }),
      ).toMatchObject({
        previousStatus: "completed",
        status: "completed",
        changed: false,
        matched: false,
        timedOut: true,
      });
    } finally {
      events.close();
    }
  });

  it("does not invent a current baseline when no status exists at the cursor", async () => {
    const events = createGatewayEventStore();
    const port = {
      ...makePort(),
      listThreads: async () => ({
        snapshotAt: "now",
        items: [{ id: "chat-1", status: "completed" }],
      }),
    };
    events.emit({ environmentId: "local", threadId: "chat-1", type: "thread.completed" });
    try {
      expect(
        await callGatewayTool({ port, grants: readGrants, events }, "t3_wait_for_thread_status", {
          environmentId: "local",
          threadId: "chat-1",
          afterSequence: 0,
          timeoutMs: 250,
        }),
      ).toMatchObject({
        previousStatus: null,
        status: "completed",
        matched: true,
        timedOut: false,
      });
    } finally {
      events.close();
    }
  });

  it("rejects expired resume cursors even when the current status matches", async () => {
    const events = createGatewayEventStore({ retentionEvents: 1 });
    events.emit({ environmentId: "local", threadId: "chat-1", type: "thread.started" });
    events.emit({ environmentId: "local", threadId: "chat-1", type: "thread.completed" });
    const port = {
      ...makePort(),
      listThreads: async () => ({
        snapshotAt: "now",
        items: [{ id: "chat-1", status: "completed" }],
      }),
    };
    try {
      await expect(
        callGatewayTool({ port, grants: readGrants, events }, "t3_wait_for_thread_status", {
          environmentId: "local",
          threadId: "chat-1",
          afterSequence: 0,
          untilStatuses: ["completed"],
        }),
      ).rejects.toMatchObject({ code: "cursor_expired" });
    } finally {
      events.close();
    }
  });

  it("returns immediately when the chat already matches and otherwise times out", async () => {
    const events = createGatewayEventStore();
    const port = {
      ...makePort(),
      listThreads: async () => ({
        snapshotAt: "now",
        items: [{ id: "chat-1", projectId: "p", status: "waiting-input", settledAt: null }],
      }),
    };
    const context = { port, grants: readGrants, events };
    await expect(
      callGatewayTool(context, "t3_wait_for_thread_status", {
        environmentId: "local",
        threadId: "chat-1",
        untilStatuses: ["waiting-input"],
      }),
    ).resolves.toMatchObject({
      status: "waiting-input",
      previousStatus: "waiting-input",
      changed: false,
      matched: true,
      timedOut: false,
    });
    await expect(
      callGatewayTool(context, "t3_wait_for_thread_status", {
        environmentId: "local",
        threadId: "chat-1",
        untilStatuses: ["completed"],
        timeoutMs: 250,
      }),
    ).resolves.toMatchObject({ status: "waiting-input", matched: false, timedOut: true });
  });

  it("requires the durable event store and a valid target status", async () => {
    const port = {
      ...makePort(),
      listThreads: async () => ({
        snapshotAt: "now",
        items: [{ id: "chat-1", projectId: "p", status: "running", settledAt: null }],
      }),
    };
    await expect(
      callGatewayTool({ port, grants: readGrants }, "t3_wait_for_thread_status", {
        environmentId: "local",
        threadId: "chat-1",
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
    const events = createGatewayEventStore();
    await expect(
      callGatewayTool({ port, grants: readGrants, events }, "t3_wait_for_thread_status", {
        environmentId: "local",
        threadId: "chat-1",
        untilStatuses: ["nope"],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("shared skill tools", () => {
  const input = {
    environmentId: "local",
    name: "Review",
    description: "Review PRs",
    content: "# Review\nCheck correctness",
    resources: [{ path: "assets/raw.bin", contentBase64: "AP+A/w==", executable: false }],
  };
  function skillPort() {
    const skill = {
      ...input,
      skillId: "review",
      revision: 1,
      createdAt: "2026-09-21T00:00:00Z",
      updatedAt: "2026-09-21T00:00:00Z",
    };
    return {
      ...makePort(),
      listSkills: vi.fn(async () => [skill]),
      createSkill: vi.fn(async () => skill),
      updateSkill: vi.fn(async (_env, _id, patch) => ({ ...skill, ...patch, revision: 2 })),
      deleteSkill: vi.fn(async (_env, skillId) => ({ skillId, status: "succeeded" as const })),
      syncAgentLibrary: vi.fn(async () => {}),
    } satisfies GatewayRuntimePort;
  }
  it("lists content and saves edits through the runtime, synchronizing permitted machines", async () => {
    const port = skillPort();
    const context = { port, grants: { local: ["read", "create"], remote: ["create"] } as const };
    expect(
      await callGatewayTool(context, "t3_list_skills", { environmentId: "local" }),
    ).toMatchObject({ items: [{ skillId: "review", content: input.content }] });
    expect(await callGatewayTool(context, "t3_create_skill", input)).toMatchObject({
      skill: { skillId: "review" },
      sync: { failedEnvironmentIds: [] },
    });
    expect(port.createSkill).toHaveBeenCalledWith("local", {
      name: input.name,
      description: input.description,
      content: input.content,
      resources: input.resources,
    });
    expect(port.syncAgentLibrary).toHaveBeenCalledWith("remote");
    expect(
      await callGatewayTool(context, "t3_update_skill", {
        environmentId: "local",
        skillId: "review",
        patch: { content: "New instructions" },
      }),
    ).toMatchObject({ skill: { revision: 2, content: "New instructions" } });
    expect(
      await callGatewayTool(context, "t3_delete_skill", {
        environmentId: "local",
        skillId: "review",
      }),
    ).toMatchObject({ skillId: "review", status: "succeeded" });
    expect(port.deleteSkill).toHaveBeenCalledWith("local", "review");
  });
  it("rejects read-only mutations and invalid content without writing", async () => {
    const port = skillPort();
    await expect(
      callGatewayTool({ port, grants: { local: ["read"] } }, "t3_create_skill", input),
    ).rejects.toMatchObject({ code: "scope_required" });
    await expect(
      callGatewayTool({ port, grants: { local: ["create"] } }, "t3_create_skill", {
        ...input,
        content: " ",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      callGatewayTool({ port, grants: { local: ["create"] } }, "t3_update_skill", {
        environmentId: "local",
        skillId: "review",
        patch: { revision: 999 },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(port.createSkill).not.toHaveBeenCalled();
    expect(port.updateSkill).not.toHaveBeenCalled();
  });
  it("does not share without a destination write grant and reports sync failures after saving", async () => {
    const port = skillPort();
    await callGatewayTool(
      { port, grants: { local: ["create"], remote: ["read"] } },
      "t3_create_skill",
      input,
    );
    expect(port.syncAgentLibrary).not.toHaveBeenCalled();
    port.syncAgentLibrary.mockRejectedValue(new Error("Disconnected"));
    expect(
      await callGatewayTool(
        { port, grants: { local: ["create"], remote: ["admin"] } },
        "t3_create_skill",
        input,
      ),
    ).toMatchObject({ skill: { skillId: "review" }, sync: { failedEnvironmentIds: ["remote"] } });
  });
});

describe("pending question tools", () => {
  const pendingQuestions = [
    {
      questionRequestId: "question-1",
      askedAt: "2026-09-26T00:00:00.000Z",
      questions: [
        {
          questionId: "approach",
          header: "Approach",
          question: "How should the hosted /mcp reuse the CLI API's checks?",
          multiSelect: false,
          allowsFreeText: true,
          options: [
            { label: "Shared operation layer", description: "Move the checks in-process." },
            { label: "HTTP loopback", description: "Call /api/cli/v1.", value: "loopback" },
          ],
        },
        {
          questionId: "surfaces",
          header: "Surfaces",
          question: "Which clients should ship first?",
          multiSelect: true,
          allowsFreeText: false,
          options: [
            { label: "Web", description: "" },
            { label: "Desktop", description: "" },
            { label: "Mobile", description: "" },
          ],
        },
      ],
    },
  ];

  function questionPort(pending: ReadonlyArray<unknown> = pendingQuestions) {
    const port = makePort();
    port.getThread = async (_environmentId, threadId) => ({
      id: threadId,
      title: "Plan the hosted MCP",
      status: "waiting-input",
      pendingQuestions: pending,
    });
    const respondToUserInput = vi.fn(async (input: { requestId: string; threadId: string }) => ({
      requestId: input.requestId,
      commandId: input.requestId,
      status: "accepted" as const,
      threadId: input.threadId,
    }));
    port.respondToUserInput = respondToUserInput;
    return { port, respondToUserInput };
  }
  const grants = { local: ["read", "send"] as const };
  const answer = (answers: ReadonlyArray<Record<string, unknown>>, key = "answer-1") => ({
    environmentId: "local",
    threadId: "chat",
    answers,
    idempotencyKey: key,
  });

  it("reads every question and option with read access", async () => {
    const { port } = questionPort();
    await expect(
      callGatewayTool({ port, grants: { local: ["read"] } }, "t3_get_pending_questions", {
        environmentId: "local",
        threadId: "chat",
      }),
    ).resolves.toMatchObject({ threadId: "chat", status: "waiting-input", pendingQuestions });
  });

  it("answers by option label, multi-select, and free text with the provider's values", async () => {
    const { port, respondToUserInput } = questionPort();
    const receipt = await callGatewayTool(
      { port, grants },
      "t3_answer_question",
      answer([
        { questionId: "approach", options: ["http loopback"] },
        { questionId: "surfaces", options: ["Web", "Mobile", "Web"] },
      ]),
    );
    expect(receipt).toMatchObject({
      status: "accepted",
      questionRequestId: "question-1",
      answers: { approach: "loopback", surfaces: ["Web", "Mobile"] },
    });
    expect(respondToUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "local",
        threadId: "chat",
        userInputRequestId: "question-1",
        answers: { approach: "loopback", surfaces: ["Web", "Mobile"] },
      }),
    );

    await callGatewayTool(
      { port, grants },
      "t3_answer_question",
      answer(
        [
          { questionId: "approach", text: "Plan only for now" },
          { questionId: "surfaces", options: ["Desktop"] },
        ],
        "answer-2",
      ),
    );
    expect(respondToUserInput).toHaveBeenLastCalledWith(
      expect.objectContaining({
        answers: { approach: "Plan only for now", surfaces: ["Desktop"] },
      }),
    );
  });

  it("rejects answers the question cannot take before reaching the provider", async () => {
    const { port, respondToUserInput } = questionPort();
    const rejected = async (answers: ReadonlyArray<Record<string, unknown>>, message: string) => {
      await expect(
        callGatewayTool({ port, grants }, "t3_answer_question", answer(answers)),
      ).rejects.toThrow(message);
    };
    await rejected(
      [
        { questionId: "approach", options: ["Shared operation layer", "HTTP loopback"] },
        { questionId: "surfaces", options: ["Web"] },
      ],
      '"Approach" takes exactly one option.',
    );
    await rejected(
      [
        { questionId: "approach", options: ["Shared operation layer"] },
        { questionId: "surfaces", text: "All of them" },
      ],
      '"Surfaces" only accepts one of its options.',
    );
    await rejected(
      [
        { questionId: "approach", options: ["Rewrite it"] },
        { questionId: "surfaces", options: ["Web"] },
      ],
      '"Rewrite it" is not an option for "Approach". Options: Shared operation layer, HTTP loopback.',
    );
    await rejected(
      [{ questionId: "approach", options: ["Shared operation layer"] }],
      "Missing: Surfaces.",
    );
    await rejected([{ options: ["Web"] }], "pass questionId with each answer");
    expect(respondToUserInput).not.toHaveBeenCalled();
  });

  it("reports a chat that is no longer waiting instead of answering", async () => {
    const { port, respondToUserInput } = questionPort([]);
    await expect(
      callGatewayTool(
        { port, grants },
        "t3_answer_question",
        answer([{ options: ["Shared operation layer"] }]),
      ),
    ).rejects.toMatchObject({ code: "stale_plan" });
    expect(respondToUserInput).not.toHaveBeenCalled();
  });

  it("needs send access, and a retry does not answer twice", async () => {
    const single = [{ ...pendingQuestions[0]!, questions: [pendingQuestions[0]!.questions[0]!] }];
    const { port, respondToUserInput } = questionPort(single);
    const request = answer([{ options: ["Shared operation layer"] }]);
    await expect(
      callGatewayTool({ port, grants: { local: ["read"] } }, "t3_answer_question", request),
    ).rejects.toThrow();
    const events = createGatewayEventStore();
    const first = await callGatewayTool({ port, grants, events }, "t3_answer_question", request);
    const retry = await callGatewayTool({ port, grants, events }, "t3_answer_question", request);
    expect(retry).toEqual(first);
    expect(respondToUserInput).toHaveBeenCalledTimes(1);
    expect(respondToUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { approach: "Shared operation layer" } }),
    );
  });

  it("attaches pending questions to waiting chats in the thread list on request", async () => {
    const { port } = questionPort();
    port.listThreads = async () => ({
      snapshotAt: "runtime",
      items: [
        {
          id: "chat",
          hasPendingUserInput: true,
          status: "waiting-input",
          updatedAt: "2026-09-07T02:00:00Z",
        },
        {
          id: "busy",
          hasPendingUserInput: false,
          status: "running",
          updatedAt: "2026-09-07T01:00:00Z",
        },
      ],
    });
    const listed = (await callGatewayTool({ port, grants }, "t3_list_threads", {
      environmentId: "local",
      includeQuestions: true,
    })) as { items: ReadonlyArray<Record<string, unknown>> };
    expect(listed.items[0]).toMatchObject({ id: "chat", pendingQuestions });
    expect(listed.items[1]).not.toHaveProperty("pendingQuestions");
  });
});

describe("bounded thread list", () => {
  // 30 chats per machine, one per minute; both machines share every timestamp so ties cross pages.
  const minute = (n: number) => `2026-09-07T00:${String(n).padStart(2, "0")}:00.000Z`;
  const chatId = (environmentId: string, n: number) =>
    `${environmentId}-${String(n).padStart(2, "0")}`;
  const newestFirst = (count: number) =>
    Array.from({ length: count }, (_, k) => [chatId("a", 29 - k), chatId("b", 29 - k)]).flat();
  const chats = (environmentId: string) =>
    Array.from({ length: 30 }, (_, n) => ({
      id: chatId(environmentId, n),
      projectId: n % 2 === 0 ? "even" : "odd",
      title: `Chat ${n}`,
      status: n % 3 === 0 ? "running" : "completed",
      settledAt: null,
      hasPendingUserInput: n === 29,
      profileSnapshot: { profileId: n % 5 === 0 ? "review" : "code", profileName: "Code" },
      modelSelection: { instanceId: "codex", model: "gpt-5", options: [{ id: "effort" }] },
      latestRunId: `run-${n}`,
      createdAt: minute(n),
      updatedAt: minute(n),
    }));
  function boundedContext() {
    const getThread = vi.fn(async () => ({ pendingQuestions: [] }));
    const port: GatewayRuntimePort = {
      ...makePort(),
      listEnvironments: async () =>
        ["a", "b"].map((environmentId) => ({
          environmentId,
          label: environmentId.toUpperCase(),
          targetKind: "relay" as const,
          connectionState: "connected" as const,
        })),
      listThreads: async (environmentId) => ({ snapshotAt: "now", items: chats(environmentId) }),
      getThread,
    };
    return { port, getThread, grants: { a: ["read"], b: ["read"] } as const };
  }
  type Listed = {
    items: ReadonlyArray<Record<string, unknown>>;
    hasMore: boolean;
    nextCursor: string | null;
  };
  const list = (context: ReturnType<typeof boundedContext>, input: Record<string, unknown> = {}) =>
    callGatewayTool(context, "t3_list_threads", input) as Promise<Listed>;
  const ids = (page: Listed) => page.items.map((row) => row.id);

  it("returns the latest 20 compact rows by default and pages without overlap or gaps", async () => {
    const context = boundedContext();
    const first = await list(context);
    expect(ids(first)).toEqual(newestFirst(10));
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).toEqual({
      id: "a-29",
      environmentId: "a",
      environmentLabel: "A",
      projectId: "odd",
      title: "Chat 29",
      status: "completed",
      hasPendingUserInput: true,
      hasPendingApprovals: undefined,
      profileId: "code",
      profileName: "Code",
      providerInstanceId: "codex",
      model: "gpt-5",
      parentThreadId: null,
      parentEnvironmentId: null,
      settledAt: null,
      createdAt: minute(29),
      updatedAt: minute(29),
    });

    const seen: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(context, { limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...ids(page));
      cursor = page.nextCursor ?? undefined;
      expect(page.hasMore).toBe(cursor !== undefined);
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(9);
    expect(seen).toEqual(newestFirst(30));

    await expect(list(context, { limit: 101 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(list(context, { cursor: "not-a-cursor" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("applies time windows and combined filters across environments before truncating", async () => {
    const context = boundedContext();
    expect(ids(await list(context, { updatedAfter: minute(28) }))).toEqual([
      "a-29",
      "b-29",
      "a-28",
      "b-28",
    ]);
    expect(ids(await list(context, { updatedBefore: minute(2), limit: 100 }))).toEqual([
      "a-01",
      "b-01",
      "a-00",
      "b-00",
    ]);
    expect(
      ids(await list(context, { createdAfter: minute(27), updatedBefore: minute(29) })),
    ).toEqual(["a-28", "b-28", "a-27", "b-27"]);
    await expect(list(context, { updatedAfter: "yesterday" })).rejects.toMatchObject({
      code: "invalid_input",
    });

    // Matches sit at n = 0, 6, 12, 18, 24 on each machine; oldest ones still reach the page.
    const combined = await list(context, {
      projectId: "even",
      executionState: "running",
      profileId: "code",
      limit: 5,
    });
    expect(ids(combined)).toEqual(["a-24", "b-24", "a-18", "b-18", "a-12"]);
    const rest = await list(context, {
      projectId: "even",
      executionState: "running",
      profileId: "code",
      cursor: combined.nextCursor,
    });
    expect(ids(rest)).toEqual(["b-12", "a-06", "b-06"]);
    expect(rest.hasMore).toBe(false);
  });

  it("reads pending questions only for chats on the returned page", async () => {
    const context = boundedContext();
    const page = await list(context, { includeQuestions: true, updatedBefore: minute(29) });
    expect(page.items).toHaveLength(20);
    expect(context.getThread).not.toHaveBeenCalled();
    await list(context, { includeQuestions: true, limit: 1 });
    expect(context.getThread).toHaveBeenCalledExactlyOnceWith("a", "a-29");
  });
});

describe("cross-environment discovery", () => {
  const profile = (profileId: string, environmentIds?: ReadonlyArray<string>): GatewayProfile => ({
    profileId,
    name: profileId,
    providerLabel: "Codex",
    modelLabel: "GPT-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    ...(environmentIds === undefined ? {} : { environmentIds }),
  });
  const threadsByEnvironment: Record<string, ReadonlyArray<Record<string, unknown>>> = {
    macbook: [
      {
        id: "mac-idle",
        projectId: "t3",
        status: "idle",
        profileSnapshot: { profileId: "code" },
        updatedAt: "2026-09-07T02:00:00Z",
      },
    ],
    "dev-box": [
      {
        id: "tensorfold",
        projectId: "tf",
        status: "running",
        profileSnapshot: { profileId: "code" },
        updatedAt: "2026-09-07T01:00:00Z",
      },
    ],
  };
  function discoveryPort(): GatewayRuntimePort {
    return {
      ...makePort(),
      listEnvironments: async () => [
        {
          environmentId: "macbook",
          label: "MacBook",
          targetKind: "primary",
          connectionState: "connected",
        },
        {
          environmentId: "dev-box",
          label: "dev-box",
          targetKind: "relay",
          connectionState: "connected",
        },
        {
          environmentId: "broken",
          label: "Broken",
          targetKind: "relay",
          connectionState: "connected",
        },
        {
          environmentId: "laptop",
          label: "Laptop",
          targetKind: "relay",
          connectionState: "disconnected",
        },
        {
          environmentId: "phone",
          label: "Phone",
          targetKind: "relay",
          connectionState: "connected",
        },
        {
          environmentId: "ungranted",
          label: "Other",
          targetKind: "relay",
          connectionState: "connected",
        },
      ],
      listThreads: async (environmentId) => {
        if (environmentId === "broken") throw new Error("snapshot timed out");
        return { snapshotAt: "now", items: threadsByEnvironment[environmentId] ?? [] };
      },
      listProfiles: async () => [profile("code"), profile("review", ["dev-box"])],
    };
  }
  const context = {
    port: discoveryPort(),
    grants: {
      macbook: ["read"],
      "dev-box": ["read"],
      broken: ["read"],
      laptop: ["read"],
      phone: ["create"],
    },
  } as const;
  const coverage = [
    { environmentId: "macbook", environmentLabel: "MacBook", status: "listed" },
    { environmentId: "dev-box", environmentLabel: "dev-box", status: "listed" },
    { environmentId: "broken", status: "failed", reason: "snapshot timed out" },
    { environmentId: "laptop", status: "skipped", reason: "disconnected" },
    { environmentId: "phone", status: "skipped", reason: "read not granted" },
  ];

  it("lists chats from every connected environment, tagged, and reports what it missed", async () => {
    const listed = await callGatewayTool(context, "t3_list_threads", {});
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: "mac-idle",
        environmentId: "macbook",
        environmentLabel: "MacBook",
      }),
      expect.objectContaining({
        id: "tensorfold",
        environmentId: "dev-box",
        environmentLabel: "dev-box",
      }),
    ]);
    expect(listed.environments).toMatchObject(coverage);

    const running = await callGatewayTool(context, "t3_list_threads", {
      executionState: "running",
    });
    expect(running.items.map((thread: { id: string }) => thread.id)).toEqual(["tensorfold"]);
    await expect(
      callGatewayTool(context, "t3_list_threads", { executionState: "sleeping" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps one-environment listings scoped while tagging their items", async () => {
    const listed = await callGatewayTool(context, "t3_list_threads", { environmentId: "dev-box" });
    expect(listed).toEqual({
      snapshotAt: "now",
      items: [expect.objectContaining({ id: "tensorfold", environmentLabel: "dev-box" })],
      hasMore: false,
      nextCursor: null,
    });
    await expect(
      callGatewayTool(context, "t3_list_threads", { environmentId: "phone" }),
    ).rejects.toMatchObject({ code: "scope_required" });
  });

  it("lists projects across environments", async () => {
    const listed = await callGatewayTool(context, "t3_list_projects", {});
    expect(listed.items).toEqual([
      expect.objectContaining({ id: "macbook-project", environmentId: "macbook" }),
      expect.objectContaining({ id: "dev-box-project", environmentId: "dev-box" }),
      expect.objectContaining({ id: "broken-project", environmentId: "broken" }),
    ]);
  });

  it("lists each shared agent once with the machines it is available on", async () => {
    const listed = await callGatewayTool(context, "t3_list_agents", {});
    expect(listed.items).toEqual([
      expect.objectContaining({
        profileId: "code",
        availableEnvironmentIds: ["macbook", "dev-box", "broken"],
      }),
      expect.objectContaining({ profileId: "review", availableEnvironmentIds: ["dev-box"] }),
    ]);
  });

  it("collects each agent's runs from every environment onto one board card", async () => {
    const board = await callGatewayTool(context, "t3_get_agents_view", { profileId: "code" });
    expect(board.items).toEqual([
      expect.objectContaining({
        profileId: "code",
        runs: [
          expect.objectContaining({ threadId: "mac-idle", environmentId: "macbook" }),
          expect.objectContaining({ threadId: "tensorfold", environmentLabel: "dev-box" }),
        ],
      }),
    ]);
    expect(board.environments).toMatchObject(coverage);
  });
});
