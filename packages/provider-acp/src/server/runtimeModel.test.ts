import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/compat";

import {
  decideToolCallUpdateEmission,
  applyAcpAgentTerminalUpdate,
  acpContentBlockDisplayText,
  embeddedTerminalIdsFromSessionUpdate,
  extractMcpToolCallIdentity,
  makeAcpUnreadToolCalls,
  MAX_UNREAD_TOOL_CALLS,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionModelStateFromInitialize,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
  toolCallProgressLength,
  toolCallVisibleOutputChanged,
  unreadToolCallUpdate,
  withTrackedChangedPaths,
  withTrackedPermissionToolCall,
  withUnknownChangedPaths,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import { acpChangedPathsOfToolCall } from "./clientPolicy.ts";

describe("AcpRuntimeModel", () => {
  it("parses session mode state from typed ACP session setup responses", () => {
    const modeState = parseSessionModeState({
      sessionId: "session-1",
      modes: {
        currentModeId: " code ",
        availableModes: [
          { id: " ask ", name: " Ask ", description: " Request approval " },
          { id: " code ", name: " Code " },
        ],
      },
      configOptions: [],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modeState).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval" },
        { id: "code", name: "Code" },
      ],
    });
  });

  it("detects Grok session replay updates from _meta.isReplay", () => {
    expect(
      sessionUpdateIsReplay({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateIsReplay({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
  });

  it("ignores Grok keepalive chunks when tracking session/load replay activity", () => {
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
    expect(
      sessionUpdateCountsAsLoadReplayActivity({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "replay-tool",
          title: "Replay",
          kind: "search",
          status: "completed",
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
  });

  it("ignores load-replay activity from other sessions while a load gate is active", () => {
    expect(
      sessionUpdateCountsAsLoadReplayActivity(
        {
          sessionId: "session-other",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "unrelated" },
          },
        } satisfies EffectAcpSchema.SessionNotification,
        "session-loading",
      ),
    ).toBe(false);
    expect(
      sessionUpdateCountsAsLoadReplayActivity(
        {
          sessionId: "session-loading",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replay" },
          },
        } satisfies EffectAcpSchema.SessionNotification,
        "session-loading",
      ),
    ).toBe(true);
  });

  it("ignores malformed initialize mode state in synthetic load responses", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: 12 }],
        },
      },
    } as EffectAcpSchema.InitializeResponse);

    expect(response.modes).toBeUndefined();
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });

  it("keeps initialize mode state whose modes have null descriptions", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [
            { id: "ask", name: "Ask", description: null },
            { id: "code", name: "Code", description: "Edit files", _meta: null },
          ],
          _meta: null,
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(parseSessionModeState(response)).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code", description: "Edit files" },
      ],
    });
  });

  it("reads initialize model state and ignores malformed model state", () => {
    const modelState = {
      currentModelId: "grok-4.7",
      availableModels: [
        {
          modelId: "grok-4.7",
          name: "Grok 4.7",
          description: null,
          _meta: { reasoningEfforts: [{ id: "high", default: true }] },
        },
        { modelId: "grok-4.6", name: "Grok 4.6" },
      ],
    };

    expect(sessionModelStateFromInitialize({ protocolVersion: 1, _meta: { modelState } })).toEqual(
      modelState,
    );
    expect(
      sessionModelStateFromInitialize({
        protocolVersion: 1,
        _meta: {
          modelState: { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.7" }] },
        },
      }),
    ).toBeUndefined();
    expect(
      sessionModelStateFromInitialize({
        protocolVersion: 1,
        _meta: { modelState: { ...modelState, _meta: "not an object" } },
      }),
    ).toBeUndefined();
  });

  it("projects typed ACP tool call updates into runtime events", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {
          executable: "bun",
          args: ["run", "typecheck"],
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Running checks",
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(created.events).toEqual([
      {
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          title: "Ran command",
          status: "pending",
          command: "bun run typecheck",
          detail: "bun run typecheck",
          data: {
            toolCallId: "tool-1",
            kind: "execute",
            title: "Terminal",
            command: "bun run typecheck",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
      },
    ]);

    const updated = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]?._tag).toBe("ToolCallUpdated");
    const createdEvent = created.events[0];
    const updatedEvent = updated.events[0];
    if (createdEvent?._tag === "ToolCallUpdated" && updatedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall)).toMatchObject({
        toolCallId: "tool-1",
        status: "completed",
        title: "Ran command",
        detail: "bun run typecheck",
        command: "bun run typecheck",
      });
    }
  });

  it("ends a tool call that ACP reports as cancelled", () => {
    const toolCall = (status: EffectAcpSchema.ToolCallStatus) => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: {
          sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
          toolCallId: "tool-1",
          title: "Run `sleep 60`",
          kind: "execute",
          status,
        },
      } as EffectAcpSchema.SessionNotification);
      const event = parsed.events[0];
      if (event?._tag !== "ToolCallUpdated") {
        throw new Error("expected a tool call update");
      }
      return event.toolCall;
    };

    const running = toolCall("in_progress");
    const cancelled = mergeToolCallState(running, toolCall("cancelled"));
    expect(cancelled.status).toBe("failed");
    expect(
      decideToolCallUpdateEmission({
        previous: running,
        next: cancelled,
        lastEmittedDetailLength: 0,
        skippedSinceEmit: 0,
      }).emit,
    ).toBe(true);
  });

  it("clears prior ACP locations when an update explicitly replaces them", () => {
    const toolCall = (locations?: EffectAcpSchema.ToolCallLocation[] | null) => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "read-1",
          ...(locations === undefined ? {} : { locations }),
        },
      } satisfies EffectAcpSchema.SessionNotification);
      const event = parsed.events.find((candidate) => candidate._tag === "ToolCallUpdated");
      if (!event || event._tag !== "ToolCallUpdated") {
        throw new Error("expected a tool call update");
      }
      return event.toolCall;
    };

    const created = toolCall([{ path: "README" }]);
    expect(mergeToolCallState(created, toolCall()).data.locations).toEqual([{ path: "README" }]);
    const cleared = mergeToolCallState(created, toolCall([]));
    expect(cleared.data.locations).toEqual([]);
    expect(mergeToolCallState(created, toolCall(null)).data.locations).toEqual([]);
    const emits = (previous: AcpToolCallState, next: AcpToolCallState) =>
      decideToolCallUpdateEmission({
        previous,
        next,
        lastEmittedDetailLength: 0,
        skippedSinceEmit: 0,
      }).emit;
    expect(emits(created, cleared)).toBe(true);
    expect(toolCallVisibleOutputChanged(created, cleared)).toBe(true);
    const relocated = mergeToolCallState(cleared, toolCall([{ path: "/workspace/src/app.ts" }]));
    expect(emits(cleared, relocated)).toBe(true);
    expect(toolCallVisibleOutputChanged(cleared, relocated)).toBe(true);
    const repeated = mergeToolCallState(relocated, toolCall([{ path: "/workspace/src/app.ts" }]));
    expect(emits(relocated, repeated)).toBe(false);
    expect(toolCallVisibleOutputChanged(relocated, repeated)).toBe(false);
  });

  it("clears explicitly nulled ACP v2 tool call fields and replaces raw input", () => {
    const toolCall = (update: Omit<EffectAcpSchema.ToolCallUpdate, "toolCallId">) => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", ...update },
      } satisfies EffectAcpSchema.SessionNotification);
      const event = parsed.events.find((candidate) => candidate._tag === "ToolCallUpdated");
      if (!event || event._tag !== "ToolCallUpdated") {
        throw new Error("expected a tool call update");
      }
      return event.toolCall;
    };

    const created = toolCall({
      name: "old-name",
      title: "Old title",
      kind: "read",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "old output" } }],
      rawInput: { path: "old.txt", obsolete: true },
      _meta: { old: true },
    });

    expect(
      mergeToolCallState(created, toolCall({ rawInput: { path: "new.txt" } })).data.rawInput,
    ).toEqual({ path: "new.txt" });

    const cleared = mergeToolCallState(
      created,
      toolCall({
        name: null,
        title: null,
        kind: null,
        status: null,
        content: null,
        rawInput: null,
        _meta: null,
      }),
    );
    const { name, title, kind, content, rawInput, meta } = cleared.data;
    expect({ name, title, kind, content, rawInput, meta }).toEqual({});
    expect({ kind: cleared.kind, title: cleared.title, status: cleared.status }).toEqual({});
  });

  it("forwards an empty ACP v1 plan to clear previous entries", () => {
    const entries = [
      [{ content: "Inspect state", priority: "high", status: "pending" }],
      [],
    ] as const;
    const updates = entries.flatMap(
      (plan) =>
        parseSessionUpdateEvent({
          sessionId: "session-1",
          update: { sessionUpdate: "plan", entries: plan },
        }).events,
    );

    expect(updates).toMatchObject([
      {
        _tag: "PlanUpdated",
        payload: {
          nativePlanId: "legacy",
          kind: "items",
          plan: [{ step: "Inspect state", status: "pending" }],
        },
      },
      {
        _tag: "PlanUpdated",
        payload: { nativePlanId: "legacy", kind: "items", plan: [] },
      },
    ]);
  });

  it("projects typed ACP plan and content updates", () => {
    const planResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: " Inspect state ", priority: "high", status: "completed" },
          { content: "", priority: "medium", status: "in_progress" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(planResult.events).toEqual([
      {
        _tag: "PlanUpdated",
        payload: {
          nativePlanId: "legacy",
          kind: "items",
          plan: [
            { step: "Inspect state", status: "completed" },
            { step: "Step 2", status: "inProgress" },
          ],
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: " Inspect state ", priority: "high", status: "completed" },
              { content: "", priority: "medium", status: "in_progress" },
            ],
          },
        },
      },
    ]);

    const contentResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello from acp",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(contentResult.events).toEqual([
      {
        _tag: "ContentDelta",
        text: "hello from acp",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello from acp",
            },
          },
        },
      },
    ]);
  });

  it("keeps permission request parsing compatible with loose extension payloads", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
      toolCall: {
        toolCallId: "tool-1",
        title: "`cat package.json`",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Not in allowlist",
            },
          },
        ],
      },
    });

    expect(request).toMatchObject({
      kind: "execute",
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending",
        command: "cat package.json",
      },
    });
  });

  it("keeps an explicit permission request kind over the tracked tool call's kind", () => {
    const request = withTrackedPermissionToolCall(
      {
        sessionId: "session-1",
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        toolCall: { toolCallId: "tool-1", kind: "read" },
      },
      {
        toolCallId: "tool-1",
        kind: "execute",
        data: { toolCallId: "tool-1", title: "git status", rawInput: { command: "git status" } },
      },
    );

    expect(parsePermissionRequest(request)).toMatchObject({ kind: "read", detail: "git status" });
  });

  it("keeps the edges of the command or title a permission request asks about", () => {
    const detail = (toolCall: Record<string, unknown>) =>
      parsePermissionRequest({
        sessionId: "session-1",
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        toolCall: { toolCallId: "tool-1", ...toolCall },
      }).detail;

    for (const end of ["\r", "\r\n", "\n\r", "\u200D", " "]) {
      expect(detail({ kind: "execute", rawInput: { command: `git status${end}` } })).toBe(
        `git status${end}`,
      );
      expect(detail({ kind: "execute", rawInput: { command: ["git", `status${end}`] } })).toBe(
        `git status${end}`,
      );
      expect(
        detail({ kind: "execute", rawInput: { executable: "git", args: `status${end}` } }),
      ).toBe(`git status${end}`);
      expect(detail({ kind: "execute", title: `Run \`git status${end}\`` })).toBe(
        `git status${end}`,
      );
      // A title shown as it was sent keeps its edges too.
      expect(detail({ kind: "other", title: `Open example.test${end}` })).toBe(
        `Open example.test${end}`,
      );
    }
    // The tool call itself keeps its trimmed command, and a blank command is still no command.
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      toolCall: { toolCallId: "tool-1", kind: "execute", rawInput: { command: "\rgit status\r" } },
    });
    expect(request.detail).toBe("\rgit status\r");
    expect(request.toolCall?.command).toBe("git status");
    expect(detail({ kind: "execute", rawInput: { command: " \r\n" } })).toBe("Ran command");
  });

  it("keeps explicitly cleared permission request fields over the tracked tool call", () => {
    const request = withTrackedPermissionToolCall(
      {
        sessionId: "session-1",
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        toolCall: { toolCallId: "tool-1", kind: null, title: null, rawInput: null },
      },
      {
        toolCallId: "tool-1",
        kind: "execute",
        data: { toolCallId: "tool-1", title: "git status", rawInput: { command: "git status" } },
      },
    );

    expect(parsePermissionRequest(request).kind).toBe("unknown");
  });

  const trackedToolCall = (
    ...updates: ReadonlyArray<Record<string, unknown>>
  ): AcpToolCallState | undefined => {
    let tracked: AcpToolCallState | undefined;
    for (const [index, update] of updates.entries()) {
      // Shapes the wire accepts through the schema's open variants, so the types do not name them.
      const notification = {
        sessionId: "session-1",
        update: {
          sessionUpdate: index === 0 ? "tool_call" : "tool_call_update",
          toolCallId: "tool-1",
          ...(index === 0 ? { title: "Edit", kind: "edit" } : {}),
          ...update,
        },
      } as EffectAcpSchema.SessionNotification;
      for (const event of parseSessionUpdateEvent(notification).events) {
        if ("toolCall" in event && event.toolCall !== undefined) {
          tracked = mergeToolCallState(tracked, event.toolCall);
        }
      }
    }
    return tracked;
  };
  const idOnlyRequest: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "session-1",
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    toolCall: { toolCallId: "tool-1" },
  };
  const changedPathsWith = (
    tracked: AcpToolCallState | undefined,
    request: EffectAcpSchema.RequestPermissionRequest = idOnlyRequest,
  ) => acpChangedPathsOfToolCall(withTrackedChangedPaths(request, tracked).toolCall);

  it("gives an id-only permission request every path its tool call's notifications named", () => {
    const tracked = trackedToolCall({
      locations: [{ path: "/work/a.ts", line: 3 }],
      content: [{ type: "diff", path: "/elsewhere/b.ts", newText: "b" }],
      rawInput: { file_path: "/elsewhere/c.ts" },
    });
    expect(changedPathsWith(tracked)).toEqual(["/work/a.ts", "/elsewhere/b.ts", "/elsewhere/c.ts"]);
    expect(
      changedPathsWith(tracked, {
        ...idOnlyRequest,
        toolCall: { toolCallId: "tool-1", locations: [{ path: "/work/d.ts" }] },
      }),
    ).toEqual(["/work/d.ts", "/work/a.ts", "/elsewhere/b.ts", "/elsewhere/c.ts"]);
    expect(withTrackedChangedPaths(idOnlyRequest, undefined)).toBe(idOnlyRequest);
    expect(withTrackedChangedPaths(idOnlyRequest, trackedToolCall({}))).toBe(idOnlyRequest);
  });

  it("reads the session and tool call of a dropped tool-call notification", () => {
    const dropped = (update: unknown, sessionId: unknown = "session-1") =>
      unreadToolCallUpdate("session/update", { sessionId, update });
    for (const sessionUpdate of ["tool_call", "tool_call_update", "tool_call_content_chunk"]) {
      expect(dropped({ sessionUpdate, toolCallId: "tool-1", locations: [{ path: 7 }] })).toEqual({
        sessionId: "session-1",
        toolCallId: "tool-1",
      });
    }
    // An id or session that is not a non-empty string is not read.
    expect(dropped({ sessionUpdate: "tool_call_update", toolCallId: 7 })).toEqual({
      sessionId: "session-1",
    });
    expect(dropped({ sessionUpdate: "tool_call", toolCallId: "" }, 7)).toEqual({});
    // A kind that cannot be read may have been a tool call.
    expect(dropped({ toolCallId: "tool-1" })).toEqual({
      sessionId: "session-1",
      toolCallId: "tool-1",
    });
    expect(dropped("not an update")).toEqual({ sessionId: "session-1" });
    expect(unreadToolCallUpdate("session/update", null)).toEqual({});
    // Other kinds and other methods are not tool-call notifications.
    expect(dropped({ sessionUpdate: "usage_update", toolCallId: "tool-1" })).toBeUndefined();
    expect(dropped({ sessionUpdate: "a_later_kind" })).toBeUndefined();
    expect(
      unreadToolCallUpdate("elicitation/complete", {
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call", toolCallId: "tool-1" },
      }),
    ).toBeUndefined();
  });

  it("records the tool calls a dropped notification may have described", () => {
    const unread = makeAcpUnreadToolCalls();
    unread.add({ sessionId: "session-1", toolCallId: "tool-1" }, ["tool-9"]);
    expect(unread.has("session-1", "tool-1")).toBe(true);
    expect(unread.has("session-1", "tool-9")).toBe(false);
    // Tool ids are only unique within a session.
    expect(unread.has("session-2", "tool-1")).toBe(false);

    // Without a tool call id, every tool call tracked for the session is recorded.
    unread.add({ sessionId: "session-1" }, ["tool-2", "tool-3"]);
    expect(unread.has("session-1", "tool-2")).toBe(true);
    expect(unread.has("session-1", "tool-3")).toBe(true);
    expect(unread.has("session-1", "tool-4")).toBe(false);

    // Without a session, the tool call is recorded for every session.
    unread.add({ toolCallId: "tool-5" }, []);
    expect(unread.has("session-1", "tool-5")).toBe(true);
    expect(unread.has("session-2", "tool-5")).toBe(true);
  });

  it("counts every tool call as unread once too many are recorded", () => {
    const unread = makeAcpUnreadToolCalls();
    for (let index = 0; index < MAX_UNREAD_TOOL_CALLS; index += 1) {
      unread.add({ sessionId: "session-1", toolCallId: `tool-${index}` }, []);
    }
    unread.add({ sessionId: "session-1", toolCallId: "tool-0" }, []);
    expect(unread.has("session-1", "never-named")).toBe(false);
    unread.add({ sessionId: "session-1", toolCallId: "one-more" }, []);
    expect(unread.has("session-1", "one-more")).toBe(true);
    expect(unread.has("session-2", "never-named")).toBe(true);
  });

  it("makes the paths of a tool call with a dropped notification unknown", () => {
    const tracked = trackedToolCall({ locations: [{ path: "/work/a.ts" }] });
    expect(changedPathsWith(tracked)).toEqual(["/work/a.ts"]);
    expect(changedPathsWith(withUnknownChangedPaths(tracked, "tool-1"))).toBe("unknown");
    // A tool call none of whose notifications was read is unknown too.
    expect(changedPathsWith(withUnknownChangedPaths(undefined, "tool-1"))).toBe("unknown");
    expect(
      changedPathsWith(withUnknownChangedPaths(undefined, "tool-1"), {
        ...idOnlyRequest,
        toolCall: { toolCallId: "tool-1", locations: [{ path: "/work/d.ts" }] },
      }),
    ).toBe("unknown");
  });

  it("keeps a tracked tool call's paths as sent while its card shows them trimmed", () => {
    const tracked = trackedToolCall({ locations: [{ path: "/work/target " }] });
    expect(tracked?.data.locations).toEqual([{ path: "/work/target" }]);
    expect(changedPathsWith(tracked)).toEqual(["/work/target "]);
  });

  it("remembers that a tracked tool call's paths were incomplete", () => {
    const inside = [{ path: "/work/a.ts" }];
    for (const update of [
      { locations: [...inside, { path: " " }] },
      { locations: [...inside, { path: "" }] },
      { locations: [...inside, { path: 7 }] },
      { locations: [...inside, {}] },
      { locations: inside, rawInput: { path: 7 } },
      { locations: inside, content: [{ type: "diff", changes: [{ operation: "_swap" }] }] },
      { locations: inside, content: [{ type: "_t3_unknown", originalType: "_patch", raw: {} }] },
    ]) {
      const tracked = trackedToolCall(update);
      // The card still lists the paths it can show.
      expect(tracked?.data.locations).toEqual(inside);
      expect(changedPathsWith(tracked)).toBe("unknown");
      // A request that names complete paths itself does not make the call's own set complete.
      expect(
        changedPathsWith(tracked, {
          ...idOnlyRequest,
          toolCall: { toolCallId: "tool-1", locations: inside },
        }),
      ).toBe("unknown");
      // Nor does a later update that names only readable paths.
      expect(changedPathsWith(trackedToolCall(update, { locations: inside }))).toBe("unknown");
    }
  });

  it("keeps a tracked tool call's earlier paths when a later update replaces or clears them", () => {
    const replaced = trackedToolCall(
      { locations: [{ path: "/elsewhere/a.ts" }] },
      { locations: [{ path: "/work/a.ts" }] },
    );
    expect(replaced?.data.locations).toEqual([{ path: "/work/a.ts" }]);
    expect(changedPathsWith(replaced)).toEqual(["/elsewhere/a.ts", "/work/a.ts"]);

    const cleared = trackedToolCall(
      { locations: [{ path: "/elsewhere/a.ts" }], rawInput: { path: "/elsewhere/b.ts" } },
      { locations: null, rawInput: null, content: null },
      { status: "in_progress" },
    );
    expect(cleared?.data.locations).toEqual([]);
    expect(changedPathsWith(cleared)).toEqual(["/elsewhere/a.ts", "/elsewhere/b.ts"]);

    const added = trackedToolCall(
      { locations: [{ path: "/work/a.ts" }] },
      { content: [{ type: "diff", path: "/elsewhere/b.ts", newText: "b" }] },
    );
    expect(changedPathsWith(added)).toEqual(["/work/a.ts", "/elsewhere/b.ts"]);
  });

  it("treats a tracked tool call that names very many paths as unknown", () => {
    const paths = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => ({ path: `/work/${prefix}-${index}.ts` }));
    expect(changedPathsWith(trackedToolCall({ locations: paths(256, "a") }))).toHaveLength(256);
    expect(changedPathsWith(trackedToolCall({ locations: paths(257, "a") }))).toBe("unknown");
    expect(
      changedPathsWith(
        trackedToolCall({ locations: paths(200, "a") }, { locations: paths(200, "b") }),
      ),
    ).toBe("unknown");
  });

  it("bounds an oversized cumulative tool_call_update content buffer to a tail window", () => {
    const hugeText = Array.from({ length: 2_000 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join(
      "\n",
    );
    expect(hugeText.length).toBeGreaterThan(60_000);

    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        // Real tool_call_update deltas omit title; raw content then supplies detail.
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        kind: "other",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: hugeText } }],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    if (event?._tag !== "ToolCallUpdated") {
      throw new Error("expected a ToolCallUpdated event");
    }

    expect(event.toolCall.detail).toBeDefined();
    const detail = event.toolCall.detail!;
    expect(detail.length).toBe(8_028);
    expect(detail.startsWith("[Earlier output truncated]")).toBe(true);
    expect(detail.endsWith(hugeText.slice(-100))).toBe(true);

    const rawUpdate = (
      event.rawPayload as {
        readonly update: {
          readonly content: ReadonlyArray<{ readonly content: { text: string } }>;
        };
      }
    ).update;
    expect(rawUpdate.content[0]?.content.text.length).toBeLessThan(8_100);
    expect(JSON.stringify(event).length).toBeLessThan(hugeText.length);
  });

  it("coalesces 1000 rapid cumulative tool_call_update notifications for a redrawing progress bar", () => {
    let previous: AcpToolCallState | undefined;
    let lastEmittedDetailLength: number | undefined;
    let skippedSinceEmit = 0;
    let emittedCount = 0;
    let emittedBytes = 0;
    let notificationBytes = 0;
    let largestEmittedEventBytes = 0;
    let finalDetail: string | undefined;
    let cumulativeBuffer = "";

    for (let i = 0; i < 1_000; i += 1) {
      cumulativeBuffer += `frame ${i}: ${"#".repeat(50)}\n`;
      const isLast = i === 999;

      const notification = {
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          kind: "other",
          status: isLast ? "completed" : "in_progress",
          content: [{ type: "content", content: { type: "text", text: cumulativeBuffer } }],
        },
      } satisfies EffectAcpSchema.SessionNotification;
      notificationBytes += JSON.stringify(notification).length;

      const { events } = parseSessionUpdateEvent(notification);

      const event = events[0];
      if (event?._tag !== "ToolCallUpdated") {
        continue;
      }

      const merged = mergeToolCallState(previous, event.toolCall);
      const decision = decideToolCallUpdateEmission({
        previous,
        next: merged,
        lastEmittedDetailLength,
        skippedSinceEmit,
      });
      previous = merged;
      skippedSinceEmit = decision.skippedSinceEmit;
      if (decision.emit) {
        emittedCount += 1;
        const eventBytes = JSON.stringify({
          toolCall: merged,
          rawPayload: event.rawPayload,
        }).length;
        emittedBytes += eventBytes;
        largestEmittedEventBytes = Math.max(largestEmittedEventBytes, eventBytes);
        lastEmittedDetailLength = merged.detail?.length;
        finalDetail = merged.detail;
      }
    }

    expect(notificationBytes).toBeGreaterThan(31_000_000);

    expect(emittedCount).toBe(114);
    expect(largestEmittedEventBytes).toBeLessThan(25_000);
    expect(emittedBytes).toBeLessThan(2_600_000);
    expect(finalDetail).toBeDefined();
    expect(finalDetail?.endsWith(`frame 999: ${"#".repeat(50)}`)).toBe(true);
  });

  it("keeps non-text tool call content entries in order when bounding oversized text", () => {
    const hugePrefix = "x".repeat(25_000);
    const hugeTail = "y".repeat(25_000);
    const { events } = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        kind: "edit",
        status: "in_progress",
        content: [
          { type: "content", content: { type: "text", text: hugePrefix } },
          { type: "diff", path: "/repo/file.ts", oldText: "before", newText: "after" },
          { type: "content", content: { type: "text", text: hugeTail } },
          { type: "diff", path: "/repo/other.ts", oldText: "old", newText: "new" },
          { type: "content", content: { type: "text", text: "   " } },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const event = events[0];
    if (event?._tag !== "ToolCallUpdated") {
      throw new Error("expected a ToolCallUpdated event");
    }
    const content = event.toolCall.data.content as ReadonlyArray<EffectAcpSchema.ToolCallContent>;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({
      type: "diff",
      path: "/repo/file.ts",
      oldText: "before",
      newText: "after",
    });
    const lastEntry = content[1];
    if (lastEntry?.type !== "content" || lastEntry.content.type !== "text") {
      throw new Error("expected a bounded text entry");
    }
    expect(lastEntry.content.text.length).toBeLessThan(8_100);
    expect(lastEntry.content.text.endsWith(hugeTail.slice(-100))).toBe(true);
    expect(content[2]).toEqual({
      type: "diff",
      path: "/repo/other.ts",
      oldText: "old",
      newText: "new",
    });
  });

  it("bounds oversized whitespace-padded text entries even when trimmed content fits", () => {
    const padded = `${" ".repeat(40_000)}ok${" ".repeat(40_000)}`;
    expect(padded.length).toBeGreaterThan(60_000);

    const { events } = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        kind: "other",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: padded } }],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const event = events[0];
    if (event?._tag !== "ToolCallUpdated") {
      throw new Error("expected a ToolCallUpdated event");
    }

    expect(event.toolCall.detail).toBe("ok");
    const content = event.toolCall.data.content as ReadonlyArray<EffectAcpSchema.ToolCallContent>;
    const textEntry = content[0];
    if (textEntry?.type !== "content" || textEntry.content.type !== "text") {
      throw new Error("expected a bounded text entry");
    }
    expect(textEntry.content.text).toBe("ok");

    const rawUpdate = (
      event.rawPayload as {
        readonly update: {
          readonly content: ReadonlyArray<{ readonly content: { text: string } }>;
        };
      }
    ).update;
    expect(rawUpdate.content[0]?.content.text).toBe("ok");
    expect(JSON.stringify(event).length).toBeLessThan(padded.length);
  });

  describe("decideToolCallUpdateEmission", () => {
    const toolCall = (detail: string | undefined, status?: AcpToolCallState["status"]) =>
      ({
        toolCallId: "tool-1",
        title: "Grok Tool",
        ...(status ? { status } : {}),
        ...(detail ? { detail } : {}),
        data: {},
      }) satisfies AcpToolCallState;

    it("always emits terminal (completed/failed) status updates regardless of growth", () => {
      expect(
        decideToolCallUpdateEmission({
          previous: toolCall("same", "inProgress"),
          next: toolCall("same", "completed"),
          lastEmittedDetailLength: 4,
          skippedSinceEmit: 0,
        }),
      ).toEqual({ emit: true, skippedSinceEmit: 0 });

      expect(
        decideToolCallUpdateEmission({
          previous: toolCall("same", "inProgress"),
          next: toolCall("same", "failed"),
          lastEmittedDetailLength: 4,
          skippedSinceEmit: 3,
        }),
      ).toEqual({ emit: true, skippedSinceEmit: 0 });
    });

    it("coalesces command-tool updates whose content grew while detail stayed the command", () => {
      const commandCall = (stdout: string): AcpToolCallState => ({
        toolCallId: "tool-1",
        title: "Ran command",
        status: "inProgress",
        command: "ls",
        detail: "ls",
        data: {
          command: "ls",
          content: [{ type: "content", content: { type: "text", text: stdout } }],
        },
      });

      let previous: AcpToolCallState | undefined;
      let lastEmittedDetailLength: number | undefined;
      let skippedSinceEmit = 0;
      const emissions: Array<boolean> = [];

      for (let i = 1; i <= 12; i += 1) {
        const next = commandCall("x".repeat(i));
        const decision = decideToolCallUpdateEmission({
          previous,
          next,
          lastEmittedDetailLength,
          skippedSinceEmit,
        });
        emissions.push(decision.emit);
        skippedSinceEmit = decision.skippedSinceEmit;
        if (decision.emit) {
          lastEmittedDetailLength = toolCallProgressLength(next);
        }
        previous = next;
      }

      const emittedIndices = emissions.flatMap((emitted, index) => (emitted ? [index + 1] : []));
      expect(emittedIndices).toEqual([1, 11]);
    });

    it("coalesces small deltas but forces an emission after the coalesce limit", () => {
      let lastEmittedDetailLength: number | undefined = 0;
      let skippedSinceEmit = 0;
      const emissions: Array<boolean> = [];
      let previous: AcpToolCallState | undefined;

      for (let i = 1; i <= 12; i += 1) {
        const next = toolCall("x".repeat(i), "inProgress");
        const decision = decideToolCallUpdateEmission({
          previous,
          next,
          lastEmittedDetailLength,
          skippedSinceEmit,
        });
        emissions.push(decision.emit);
        skippedSinceEmit = decision.skippedSinceEmit;
        if (decision.emit) {
          lastEmittedDetailLength = next.detail?.length;
        }
        previous = next;
      }

      const emittedIndices = emissions.flatMap((emitted, index) => (emitted ? [index + 1] : []));
      expect(emittedIndices).toEqual([1, 11]);
    });

    it("retains the latest replacement snapshot when equal-length updates are coalesced", () => {
      let previous: AcpToolCallState = toolCall("frame-a", "inProgress");
      const lastEmittedDetailLength = previous.detail?.length;
      let skippedSinceEmit = 0;

      for (const detail of ["frame-b", "frame-c"]) {
        const next = mergeToolCallState(previous, toolCall(detail, "inProgress"));
        const decision = decideToolCallUpdateEmission({
          previous,
          next,
          lastEmittedDetailLength,
          skippedSinceEmit,
        });
        expect(decision.emit).toBe(false);
        skippedSinceEmit = decision.skippedSinceEmit;
        previous = next;
      }

      const completed = mergeToolCallState(previous, toolCall(undefined, "completed"));
      expect(completed.detail).toBe("frame-c");
      expect(
        decideToolCallUpdateEmission({
          previous,
          next: completed,
          lastEmittedDetailLength,
          skippedSinceEmit,
        }),
      ).toEqual({ emit: true, skippedSinceEmit: 0 });
    });
  });

  it("preserves message identity, usage, metadata, and non-text output", () => {
    const message = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: {
          type: "resource_link",
          name: "report.txt",
          title: "Report",
          description: "Generated artifact",
          uri: "file:///workspace/report.txt",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);
    const usage = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 2_500,
        size: 10_000,
        cost: { amount: 0.42, currency: "USD" },
      },
    } satisfies EffectAcpSchema.SessionNotification);
    const metadata = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: " Native session ",
        updatedAt: " 2026-08-23T00:00:00Z ",
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(message.events[0]).toMatchObject({
      _tag: "ContentDelta",
      messageId: "message-1",
      text: "Report: Generated artifact\nfile:///workspace/report.txt",
    });
    expect(usage.events[0]).toMatchObject({
      _tag: "UsageUpdated",
      usage: {
        usedTokens: 2_500,
        maxTokens: 10_000,
        cost: { amount: 0.42, currency: "USD" },
      },
    });
    expect(metadata.events[0]).toMatchObject({
      _tag: "SessionInfoUpdated",
      metadata: {
        title: "Native session",
        updatedAt: "2026-08-23T00:00:00Z",
      },
    });
  });

  it("projects ACP v2 plan replacement and removal updates", () => {
    const replaced = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "plan-1",
          entries: [
            { content: " Inspect schema ", priority: "high", status: "completed" },
            { content: "Ship integration", priority: "high", status: "in_progress" },
          ],
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);
    const removed = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: { sessionUpdate: "plan_removed", planId: "plan-1" },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(replaced.events[0]).toMatchObject({
      _tag: "PlanUpdated",
      payload: {
        nativePlanId: "plan-1",
        kind: "items",
        plan: [
          { step: "Inspect schema", status: "completed" },
          { step: "Ship integration", status: "inProgress" },
        ],
      },
    });
    expect(removed.events[0]).toMatchObject({
      _tag: "PlanUpdated",
      payload: { nativePlanId: "plan-1", kind: "removed" },
    });
  });

  it("preserves markdown, file, and future ACP plan variants by plan ID", () => {
    const updates = [
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan_update",
          plan: { type: "markdown", planId: "plan-markdown", content: "# Ship it" },
        },
      },
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan_update",
          plan: { type: "file", planId: "plan-file", uri: "file:///workspace/PLAN.md" },
        },
      },
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "plan_update",
          plan: { type: "diagram", planId: "plan-future", nodes: [] },
        },
      },
    ] as const;

    expect(updates.flatMap((update) => parseSessionUpdateEvent(update).events)).toMatchObject([
      {
        _tag: "PlanUpdated",
        payload: { nativePlanId: "plan-markdown", kind: "markdown", markdown: "# Ship it" },
      },
      {
        _tag: "PlanUpdated",
        payload: {
          nativePlanId: "plan-file",
          kind: "file",
          uri: "file:///workspace/PLAN.md",
        },
      },
      {
        _tag: "PlanUpdated",
        payload: { nativePlanId: "plan-future", kind: "unknown", contentType: "diagram" },
      },
    ]);
  });

  it("turns future ACP content and session updates into explicit placeholders", () => {
    expect(
      acpContentBlockDisplayText({
        type: "_t3_unknown",
        originalType: "chart",
        raw: { type: "chart", points: [] },
      }),
    ).toBe("[Unsupported ACP content: chart]");

    expect(
      parseSessionUpdateEvent({
        sessionId: "session-1",
        update: {
          sessionUpdate: "_t3_unknown",
          originalSessionUpdate: "timeline_update",
          raw: { sessionUpdate: "timeline_update", entries: [] },
        },
      }).events,
    ).toMatchObject([{ _tag: "UnknownUpdate", updateType: "timeline_update" }]);
  });

  it("projects ACP v2 compaction lifecycle and prompt usage", () => {
    const compacting = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "in_progress",
      },
    } satisfies EffectAcpSchema.SessionNotification);
    const compacted = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "completed",
        summary: [{ type: "text", text: "Retained the implementation decisions." }],
      },
    } satisfies EffectAcpSchema.SessionNotification);
    const idle = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        usage: { totalTokens: 420, inputTokens: 300, outputTokens: 100, thoughtTokens: 20 },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(compacting.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "acp-compaction:compact-1",
        kind: "think",
        title: "Compact context",
        status: "inProgress",
      },
    });
    expect(compacted.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "acp-compaction:compact-1",
        status: "completed",
        data: { rawOutput: "Retained the implementation decisions." },
      },
    });
    expect(idle.events).toEqual([]);

    const toolCall = (update: EffectAcpSchema.SessionUpdate) => {
      const event = parseSessionUpdateEvent({ sessionId: "session-1", update }).events[0];
      if (event?._tag !== "ToolCallUpdated") throw new Error("expected a compaction tool call");
      return event.toolCall;
    };
    const draft = toolCall({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "compact-1",
      content: { type: "text", text: "Draft summary" },
    });
    const finish = (summary?: ReadonlyArray<EffectAcpSchema.ContentBlock> | null) =>
      mergeToolCallState(
        draft,
        toolCall({
          sessionUpdate: "compaction_update",
          compactionId: "compact-1",
          status: "completed",
          ...(summary === undefined ? {} : { summary }),
        }),
      ).data.rawOutput;

    expect(finish()).toBe("Draft summary");
    expect([finish(null), finish([]), finish([{ type: "text", text: "" }])]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const fail = (
      previous: ReturnType<typeof toolCall>,
      patch: Pick<
        Extract<EffectAcpSchema.SessionUpdate, { sessionUpdate: "compaction_update" }>,
        "summary" | "error"
      >,
    ) =>
      mergeToolCallState(
        previous,
        toolCall({
          sessionUpdate: "compaction_update",
          compactionId: "compact-1",
          status: "failed",
          ...patch,
        }),
      );
    const failed = fail(draft, { error: "Budget exhausted" });
    const summaryCleared = fail(failed, { summary: null });
    const errorCleared = fail(summaryCleared, { error: null });
    const fields = (state: ReturnType<typeof toolCall>) => [
      state.data.rawOutput,
      state.data.compactionError,
    ];
    expect(fields(failed)).toEqual(["Draft summary", "Budget exhausted"]);
    expect(fields(summaryCleared)).toEqual([undefined, "Budget exhausted"]);
    expect(fields(errorCleared)).toEqual([undefined, undefined]);
    expect(fields(fail(draft, { summary: null, error: "Budget exhausted" }))).toEqual([
      undefined,
      "Budget exhausted",
    ]);
  });

  it("applies ACP v2 agent-owned terminal snapshots and output chunks", () => {
    const snapshot = applyAcpAgentTerminalUpdate(undefined, {
      sessionUpdate: "terminal_update",
      terminalId: "terminal-1",
      command: "pnpm test",
      cwd: "/workspace",
      output: { data: Buffer.from("first line\n").toString("base64") },
    });
    const chunked = applyAcpAgentTerminalUpdate(snapshot, {
      sessionUpdate: "terminal_output_chunk",
      terminalId: "terminal-1",
      data: Buffer.from("second line\n").toString("base64"),
    });
    const completed = applyAcpAgentTerminalUpdate(chunked, {
      sessionUpdate: "terminal_update",
      terminalId: "terminal-1",
      exitStatus: { exitCode: 0 },
    });

    expect(completed).toEqual({
      command: "pnpm test",
      cwd: "/workspace",
      output: "first line\nsecond line\n",
      outputBytes: 23,
      exitStatus: { exitCode: 0 },
    });
  });

  it("preserves UTF-8 characters split across ACP terminal output chunks", () => {
    const bytes = Buffer.from("A🙂B", "utf8");
    const first = applyAcpAgentTerminalUpdate(undefined, {
      sessionUpdate: "terminal_output_chunk",
      terminalId: "terminal-utf8",
      data: bytes.subarray(0, 3).toString("base64"),
    });
    const second = applyAcpAgentTerminalUpdate(first, {
      sessionUpdate: "terminal_output_chunk",
      terminalId: "terminal-utf8",
      data: bytes.subarray(3).toString("base64"),
    });

    expect(first.output).toBe("A");
    expect(first.pendingOutputBytes).toBeDefined();
    expect(second.output).toBe("A🙂B");
    expect(second.pendingOutputBytes).toBeUndefined();
  });

  it("retains only the terminal output tail the projection reads", () => {
    const projectedChars = 320 * 1024;
    let state: ReturnType<typeof applyAcpAgentTerminalUpdate> | undefined;
    let full = "";
    for (let index = 0; index < 64; index += 1) {
      const text = `${index % 10}`.repeat(64 * 1024 - 1) + "é";
      full += text;
      state = applyAcpAgentTerminalUpdate(state, {
        sessionUpdate: "terminal_output_chunk",
        terminalId: "terminal-tail",
        data: Buffer.from(text).toString("base64"),
      });
    }
    expect(state!.outputBytes).toBeLessThanOrEqual(4 * projectedChars);
    expect(state!.outputBytes).toBe(Buffer.byteLength(state!.output));
    expect(state!.output.slice(-projectedChars)).toBe(full.slice(-projectedChars));
  });

  it("trims full ACP terminal output by a further 256 KiB at a UTF-8 boundary", () => {
    const cap = 1280 * 1024;
    const step = 256 * 1024;
    const chunk = (text: string | Uint8Array) => ({
      sessionUpdate: "terminal_output_chunk" as const,
      terminalId: "terminal-cap",
      data: Buffer.from(text).toString("base64"),
    });
    const seeded = applyAcpAgentTerminalUpdate(undefined, {
      sessionUpdate: "terminal_update",
      terminalId: "terminal-cap",
      output: {
        data: Buffer.from(`${"a".repeat(step)}é${"a".repeat(cap - step - 3)}`).toString("base64"),
      },
    });
    expect(seeded.outputBytes).toBe(cap - 1);

    const full = applyAcpAgentTerminalUpdate(seeded, chunk("b"));
    expect(full.outputBytes).toBe(cap);
    expect(full.output.length).toBe(cap - 1);

    // The cut at one byte past the cap plus 256 KiB falls inside "é", so the whole character goes.
    const trimmed = applyAcpAgentTerminalUpdate(full, chunk("c"));
    expect(trimmed.outputBytes).toBe(cap - step - 1);
    expect(trimmed.output.length).toBe(cap - step - 1);
    expect(trimmed.output.slice(0, 2)).toBe("aa");
    expect(trimmed.output.slice(-3)).toBe("abc");

    const appended = applyAcpAgentTerminalUpdate(trimmed, chunk("🙂"));
    expect(appended.output.slice(-5)).toBe("abc🙂");
    expect(appended.output.length).toBe(trimmed.output.length + 2);
    expect(appended.outputBytes).toBe(cap - step + 3);

    expect(Buffer.byteLength(appended.output)).toBe(appended.outputBytes);

    const refilled = applyAcpAgentTerminalUpdate(appended, chunk("x".repeat(step - 3)));
    expect(refilled.outputBytes).toBe(cap);
    const pending = applyAcpAgentTerminalUpdate(refilled, chunk(Buffer.from("🙂").subarray(0, 2)));
    const exited = applyAcpAgentTerminalUpdate(pending, {
      sessionUpdate: "terminal_update",
      terminalId: "terminal-cap",
      exitStatus: { exitCode: 1 },
    });
    expect(exited.output.slice(-4)).toBe("xxx\uFFFD");
    expect(exited.outputBytes).toBe(cap - step);
    expect(exited.outputBytes).toBe(Buffer.byteLength(exited.output));

    const cleared = applyAcpAgentTerminalUpdate(exited, {
      sessionUpdate: "terminal_update",
      terminalId: "terminal-cap",
      output: null,
    });
    expect(cleared).toMatchObject({ output: "", outputBytes: 0, exitStatus: { exitCode: 1 } });
  });

  it("drops malformed and oversized ACP terminal frames without decoding them", () => {
    const seeded = applyAcpAgentTerminalUpdate(undefined, {
      sessionUpdate: "terminal_output_chunk",
      terminalId: "terminal-invalid",
      data: Buffer.from("kept").toString("base64"),
    });

    expect(
      applyAcpAgentTerminalUpdate(seeded, {
        sessionUpdate: "terminal_output_chunk",
        terminalId: "terminal-invalid",
        data: "not base64!",
      }),
    ).toBe(seeded);

    expect(
      applyAcpAgentTerminalUpdate(seeded, {
        sessionUpdate: "terminal_output_chunk",
        terminalId: "terminal-oversized",
        data: Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64"),
      }),
    ).toBe(seeded);
  });

  it("projects binary ACP content without retaining encoded payloads", () => {
    const encodedPayload = "sensitive-base64-payload";
    const binary = acpContentBlockDisplayText({
      type: "resource",
      resource: {
        blob: encodedPayload,
        mimeType: "application/octet-stream",
        uri: "file:///workspace/archive.bin",
      },
    });
    const image = acpContentBlockDisplayText({
      type: "image",
      data: encodedPayload,
      mimeType: "image/png",
      uri: "file:///workspace/image.png",
    });
    const audio = acpContentBlockDisplayText({
      type: "audio",
      data: encodedPayload,
      mimeType: "audio/wav",
    });

    expect(binary).toBe(
      "[ACP binary resource (application/octet-stream): file:///workspace/archive.bin]",
    );
    expect(image).toBe("[ACP image (image/png): file:///workspace/image.png]");
    expect(audio).toBe("[ACP audio (audio/wav)]");
    expect(`${binary}${image}${audio}`).not.toContain(encodedPayload);

    const toolUpdate = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-with-image",
        title: "Generated image",
        content: [
          {
            type: "content",
            content: {
              type: "image",
              data: encodedPayload,
              mimeType: "image/png",
              uri: `data:image/png;base64,${encodedPayload}`,
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);
    const toolEvent = toolUpdate.events.find((event) => event._tag === "ToolCallUpdated");
    expect(JSON.stringify(toolEvent?.toolCall)).not.toContain(encodedPayload);
    expect(toolUpdate.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        data: {
          content: [
            { type: "content", content: { type: "text", text: "[ACP image (image/png)]" } },
          ],
        },
      },
    });
  });
});

describe("extractMcpToolCallIdentity", () => {
  function toolCallFromUpdate(
    update: EffectAcpSchema.SessionNotification["update"],
  ): NonNullable<ReturnType<typeof parsePermissionRequest>["toolCall"]> {
    const parsed = parseSessionUpdateEvent({ sessionId: "session-1", update });
    const event = parsed.events.find(
      (
        candidate,
      ): candidate is Extract<(typeof parsed.events)[number], { _tag: "ToolCallUpdated" }> =>
        candidate._tag === "ToolCallUpdated",
    );
    if (event === undefined) throw new Error("expected a tool call event");
    return event.toolCall;
  }

  it("recovers server and tool from codex-acp tagged execute calls", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-f4591587-0754-4bb4-990b-f2767894ba93",
      kind: "execute",
      title: "mcp.t3-code.orchestrator_capabilities",
      status: "in_progress",
      rawInput: { server: "t3-code", tool: "orchestrator_capabilities", arguments: {} },
      _meta: { is_mcp_tool_call: true },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "orchestrator_capabilities",
    });
  });

  it("recovers server, tool, and arguments from Antigravity call_mcp_tool calls", () => {
    // agy 1.5.12 reaches MCP tools its context budget left out through call_mcp_tool.
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_13347576314095519317",
      kind: "execute",
      title: "MCP Tool navigate_page",
      status: "in_progress",
      rawInput: {
        ServerName: "chrome-devtools",
        ToolName: "navigate_page",
        Arguments: { url: "https://example.com" },
      },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "chrome-devtools",
      tool: "navigate_page",
      input: { url: "https://example.com" },
    });
  });

  it("recovers T3 identity from acp-mcp-call fallback commands", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-1",
      kind: "execute",
      title: "Ran command",
      status: "in_progress",
    });

    const cases = [
      {
        name: "joined argv JSON",
        command: '/usr/bin/node /srv/t3/bin.ts acp-mcp-call delegate_task {"task":"x"}',
        expected: { server: "t3-code", tool: "delegate_task", input: { task: "x" } },
      },
      {
        name: "heredoc stdin",
        command:
          'ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" ${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call html_render - <<\'EOF\'\n{"path":"/abs/page.html","title":"Report","height":420}\nEOF',
        expected: { server: "t3-code", tool: "html_render" },
      },
      {
        name: "multi-line single-quoted JSON",
        command:
          '"$T3_ACP_MCP_NODE" acp-mcp-call html_render \'{\n  "path": "/abs/page.html",\n  "title": "Report"\n}\'',
        expected: {
          server: "t3-code",
          tool: "html_render",
          input: { path: "/abs/page.html", title: "Report" },
        },
      },
      {
        name: "shell line continuation",
        command: '"$T3_ACP_MCP_NODE" acp-mcp-call \\\n  html_render \'{"path":"/abs/page.html"}\'',
        expected: {
          server: "t3-code",
          tool: "html_render",
          input: { path: "/abs/page.html" },
        },
      },
      {
        name: "truncated command",
        command:
          '"$T3_ACP_MCP_NODE" acp-mcp-call html_render \'{"html":"<p>...\n\n[Command truncated]',
        expected: { server: "t3-code", tool: "html_render" },
      },
      {
        name: "nested bash -lc",
        command:
          'bash -lc "\\"$T3_ACP_MCP_NODE\\" acp-mcp-call html_render \'{\\"path\\":\\"/p\\"}\'"',
        expected: { server: "t3-code", tool: "html_render", input: { path: "/p" } },
      },
      {
        name: "tool_call proxy",
        command: 'acp-mcp-call tool_call \'{"name":"html_render","arguments":{"path":"/p"}}\'',
        expected: { server: "t3-code", tool: "html_render", input: { path: "/p" } },
      },
      {
        name: "compound shell command",
        command:
          'cd /tmp && env ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" acp-mcp-call html_render \'{"path":"/p"}\'',
        expected: { server: "t3-code", tool: "html_render", input: { path: "/p" } },
      },
      {
        name: "here-string before fallback call",
        command: 'cat <<< ignored\n"$T3_ACP_MCP_NODE" acp-mcp-call html_render \'{"path":"/p"}\'',
        expected: { server: "t3-code", tool: "html_render", input: { path: "/p" } },
      },
      {
        name: "leading redirection before fallback call",
        command: '>render.log 2>&1 "$T3_ACP_MCP_NODE" acp-mcp-call html_render \'{"path":"/p"}\'',
        expected: { server: "t3-code", tool: "html_render", input: { path: "/p" } },
      },
      {
        name: "double-quoted heredoc delimiter with literal backslash",
        command:
          'cat <<"END\\q"\nignored\nEND\\q\n"$T3_ACP_MCP_NODE" acp-mcp-call html_render \'{"path":"/p"}\'',
        expected: { server: "t3-code", tool: "html_render", input: { path: "/p" } },
      },
      {
        name: "client terminal argv with spaces in paths",
        command: [
          "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)",
          "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
          "acp-mcp-call",
          "html_render",
          '{"path":"/p"}',
        ],
        expected: { server: "t3-code", tool: "html_render", input: { path: "/p" } },
      },
      {
        name: "client terminal argv bash -lc script",
        command: ["bash", "-lc", '"$T3_ACP_MCP_NODE" acp-mcp-call html_render \'{"path":"/p"}\''],
        expected: { server: "t3-code", tool: "html_render", input: { path: "/p" } },
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        extractMcpToolCallIdentity(toolCall, {
          embeddedTerminalCommands: [testCase.command],
        }),
        testCase.name,
      ).toEqual(testCase.expected);
    }
  });

  it("ignores shell commands that merely search for acp-mcp-call", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-search",
      kind: "execute",
      title: "Ran command",
      status: "in_progress",
    });

    for (const command of [
      'rg "acp-mcp-call" --hidden',
      "rg -n 'acp-mcp-call html_render' .",
      "rg -n acp-mcp-call html_render",
      "rg acp-mcp-call html_render",
      "grep -c 'acp-mcp-call html_render' f",
      "echo acp-mcp-call html_render",
      "cat <<'EOF'\nacp-mcp-call html_render\nEOF",
      "cat <<''\nacp-mcp-call html_render\n\n",
      "printf &>acp-mcp-call html_render",
      "rg needle . # example;acp-mcp-call html_render",
      "printf '%s\\n' bash -c 'acp-mcp-call html_render'",
    ]) {
      expect(
        extractMcpToolCallIdentity(toolCall, { embeddedTerminalCommands: [command] }),
        command,
      ).toBeUndefined();
    }
  });

  it("recovers T3 identity from pi-acp title-only fallback execs", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_JdxnvzjHHrbvyASTLVekLYWV|fc_08f5a805a7159aa6016a7ec4afad548191",
      kind: "execute",
      title:
        '"$T3_ACP_MCP_NODE" "$T3_ACP_MCP_ENTRYPOINT" acp-mcp-call orchestrator_capabilities \'{}\'',
      status: "in_progress",
      rawInput: null,
      content: [
        {
          type: "terminal",
          terminalId: "call_JdxnvzjHHrbvyASTLVekLYWV|fc_08f5a805a7159aa6016a7ec4afad548191",
        },
      ],
    });

    expect(toolCall.title).toBe("Ran command");
    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "orchestrator_capabilities",
      input: {},
    });
  });

  it("recovers T3 identity from server-namespaced titles across titleless updates", () => {
    const created = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "chatcmpl-tool-b2a6142ee1a510a5",
      kind: "other",
      title: "t3-code_orchestrator_capabilities",
      status: "pending",
      locations: [],
      rawInput: {},
    });
    const completed = toolCallFromUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "chatcmpl-tool-b2a6142ee1a510a5",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: '{"ok":true}' } }],
    });
    const merged = mergeToolCallState(created, completed);

    expect(merged.title).toBe(created.title);
    expect(extractMcpToolCallIdentity(merged)).toEqual({
      server: "t3-code",
      tool: "orchestrator_capabilities",
    });
  });

  it("recovers T3 identity across the registry agents' naming conventions", () => {
    for (const title of [
      "t3-code___delegate_task",
      "t3-code-delegate_task",
      'mcp__t3_code__delegate_task: {"mode":"async"}',
      't3-code__delegate_task: {"mode":"async"}',
      "delegate_task_t3-code",
      "t3-code/delegate_task",
      "delegate_task",
      'delegate_task: {"mode":"async"}',
      // Kimi retitles with partial JSON and middle-truncates args over 50 characters.
      'delegate_task: {"mode":"async","task":"Ru',
      'delegate_task: {"mode":"async","task":"Ru...cho child-result-42\'"}',
      // Antigravity: "Running <tool>" before agy 1.5.8, "Run mcp_<server>_<tool>" since, "?" on prompts.
      "Running delegate_task",
      "Run mcp_t3-code_delegate_task",
      "Run mcp_t3-code_delegate_task?",
    ]) {
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "convention-1",
        kind: "other",
        title,
        status: "pending",
      });
      expect(extractMcpToolCallIdentity(toolCall), title).toEqual({
        server: "t3-code",
        tool: "delegate_task",
      });
    }
  });

  it("unwraps T3 tool_call proxy invocations to the target tool and arguments", () => {
    const htmlArgs = { title: "Chart", html: "<p>hi</p>", height: 320 };
    expect(
      extractMcpToolCallIdentity(
        toolCallFromUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "proxy-1",
          kind: "other",
          title: "Run mcp_t3-code_tool_call",
          status: "pending",
          rawInput: { name: "html_render", arguments: htmlArgs },
        }),
      ),
    ).toEqual({
      server: "t3-code",
      tool: "html_render",
      input: htmlArgs,
    });

    expect(
      extractMcpToolCallIdentity(
        toolCallFromUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "proxy-2",
          kind: "other",
          title: "Running tool_call",
          status: "pending",
          rawInput: {
            server: "t3-code",
            tool: "tool_call",
            arguments: { name: "t3_thread_read", arguments: { threadId: "thread-1" } },
          },
          _meta: { is_mcp_tool_call: true },
        }),
      ),
    ).toEqual({
      server: "t3-code",
      tool: "t3_thread_read",
      input: { threadId: "thread-1" },
    });

    // A bare non-T3 `tool_call` title must not be misclassified as a T3 proxy call.
    expect(
      extractMcpToolCallIdentity(
        toolCallFromUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "proxy-3",
          kind: "other",
          title: "tool_call",
          status: "pending",
          rawInput: { name: "html_render", arguments: htmlArgs },
        }),
      ),
    ).toBeUndefined();
  });

  it("recovers T3 identity from Hermes editor-renamed MCP tool titles", () => {
    const identityFor = (title: string) =>
      extractMcpToolCallIdentity(
        toolCallFromUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "hermes-1",
          kind: "other",
          title,
          status: "pending",
          rawInput: { title: "Chart", html: "<p>hi</p>", height: 320 },
        }),
      );

    expect(identityFor("mcp__editor_t3_code_f6129534__html_render")).toEqual({
      server: "t3-code",
      tool: "html_render",
    });
    expect(identityFor("mcp__editor_github_1234abcd__html_render")).toEqual({
      server: "editor_github_1234abcd",
      tool: "html_render",
    });
  });

  it("recovers T3 identity from Kiro's @-scoped titles", () => {
    for (const tool of ["html_render", "t3_thread_read", "delegate_task"]) {
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "kiro-1",
        kind: "other",
        title: `@t3-code/${tool}`,
        status: "pending",
        rawInput: { tool_id: `t3-code::${tool}`, arguments: { threadId: "thread-1" } },
      });
      expect(extractMcpToolCallIdentity(toolCall), tool).toEqual({ server: "t3-code", tool });
    }
  });

  // regression: #33667 OMP mounts MCP tools as xd:// devices and calls them through `write`.
  it("recovers T3 identity from OMP xd:// device writes but not its doc reads", () => {
    const args = {
      html: '<svg width="320" height="120"><rect width="300" height="100" fill="#4f46e5"/></svg>',
      title: "Static SVG",
    };
    const result = {
      htmlRender: { attachmentId: "synthetic-attachment-html", title: "Static SVG", height: 136 },
      message: "Shown to the reader above your reply.",
    };
    const text = JSON.stringify(result);
    const created = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_015ATZG99gw99Rrp4htieLux",
      title: "Rendering static SVG",
      kind: "execute",
      status: "pending",
      rawInput: { path: "xd://mcp__t3_code_html_render", content: JSON.stringify(args) },
    });
    const completed = mergeToolCallState(
      created,
      toolCallFromUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_015ATZG99gw99Rrp4htieLux",
        status: "completed",
        rawOutput: {
          content: [{ type: "text", text }],
          details: {
            xdev: {
              tool: "mcp__t3_code_html_render",
              mode: "execute",
              args,
              tier: "write",
              inner: {
                serverName: "t3-code",
                mcpToolName: "html_render",
                rawContent: [{ type: "text", text }],
                provider: "acp",
                providerName: "ACP Client",
                structuredContent: result,
              },
            },
          },
        },
        content: [{ type: "content", content: { type: "text", text } }],
      }),
    );
    const docRead = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_read",
      title: "Reading html_render schema",
      kind: "read",
      status: "pending",
      rawInput: { path: "xd://mcp__t3_code_html_render" },
    });

    const expected = { server: "t3-code", tool: "html_render", input: args };
    expect(extractMcpToolCallIdentity(created), "pending write").toEqual(expected);
    expect(extractMcpToolCallIdentity(completed), "completed write").toEqual(expected);
    expect(extractMcpToolCallIdentity(docRead), "doc read").toBeUndefined();
  });

  it("does not claim an agent's own tool that shares a T3 tool name", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "own-delegate-1",
      kind: "execute",
      title: "delegate_task: 1 tasks: Run the terminal command 'echo child-result-42'",
      status: "pending",
    });
    expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
  });

  it("recovers T3 identity from goose _meta despite LLM-rewritten titles", () => {
    // goose titles change asynchronously; only _meta.goose.toolCall is stable.
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "goose-1",
      title: "Checking on the delegated task",
      status: "in_progress",
      _meta: {
        goose: {
          toolCall: { toolName: "t3-code__task_status", extensionName: "t3-code" },
          messageId: "message-1",
        },
      },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "task_status",
    });
  });

  it("recovers T3 identity from qwen serverId meta regardless of prefix format", () => {
    // qwen-code 0.21.12 serverId asserts MCP origin even when tool prefixes change.
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "qwen-meta-1",
      kind: "other",
      title: "unrelated display title",
      status: "pending",
      _meta: { toolName: "mcp::t3-code::t3_thread_send", serverId: "t3-code", provenance: "mcp" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "t3_thread_send",
    });
  });

  it.each([
    { _meta: { claudeCode: { toolName: "mcp__weather__get_weather" } } },
    { _meta: { toolName: "mcp::weather::get_weather", serverId: "weather" } },
  ])("recovers external MCP identity from provider metadata", (metadata) => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "weather-call",
      title: "Checking the forecast",
      status: "in_progress",
      ...metadata,
    });
    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "weather",
      tool: "get_weather",
    });
  });

  it.each([
    { kind: "execute", toolName: "developer__shell", extensionName: "developer" },
    { kind: "edit", toolName: "developer__edit", extensionName: "developer" },
    { kind: "other", toolName: "weather__get_weather", extensionName: "weather" },
  ] as const)(
    "leaves goose $toolName unclassified so built-ins keep their projection",
    ({ kind, toolName, extensionName }) => {
      // goose tags built-in extensions exactly like user MCP servers.
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "goose-builtin",
        kind,
        title: "developer: shell",
        status: "in_progress",
        _meta: { goose: { toolCall: { toolName, extensionName } } },
      });
      expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
    },
  );

  it("uses the asserted server instead of a misleading T3 title", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "foreign-1",
      kind: "other",
      title: "t3-code_delegate_task",
      status: "pending",
      _meta: { toolName: "delegate_task", serverId: "other-orchestrator" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "other-orchestrator",
      tool: "delegate_task",
    });
  });

  it("does not brand path-like or unknown-tool titles", () => {
    for (const title of [
      "t3-code/README.md",
      "t3-code_not_a_real_tool",
      "Run mcp_t3-code_not_a_real_tool",
      "Run manage_task",
    ]) {
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "path-1",
        kind: "other",
        title,
        status: "pending",
      });
      expect(extractMcpToolCallIdentity(toolCall), title).toBeUndefined();
    }
  });

  it("leaves ordinary execute calls unidentified", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-2",
      kind: "execute",
      title: "cat package.json",
      status: "in_progress",
      rawInput: { command: "cat package.json" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
    expect(
      extractMcpToolCallIdentity(toolCall, { embeddedTerminalCommands: ["bash -lc ls"] }),
    ).toBeUndefined();
  });

  it("does not treat generic raw server and tool fields as MCP provenance", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "generic-1",
      kind: "other",
      title: "Deploy",
      status: "pending",
      rawInput: { server: "production", tool: "deploy" },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toBeUndefined();
  });

  it("unwraps T3 tool_call when Antigravity routes it through call_mcp_tool", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-mcp-proxy-1",
      kind: "execute",
      title: "MCP Tool tool_call",
      status: "completed",
      rawInput: {
        ServerName: "t3-code",
        ToolName: "tool_call",
        Arguments: {
          name: "html_render",
          arguments: { title: "Chart", html: "<p>hi</p>", height: 240 },
        },
      },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "t3-code",
      tool: "html_render",
      input: { title: "Chart", html: "<p>hi</p>", height: 240 },
    });
  });
});

describe("embeddedTerminalIdsFromSessionUpdate", () => {
  it("collects terminal ids from tool_call content before the text rewrite", () => {
    expect(
      embeddedTerminalIdsFromSessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "in_progress",
          content: [
            { type: "terminal", terminalId: "t3-term-9" },
            { type: "content", content: { type: "text", text: "noise" } },
          ],
        },
      }),
    ).toEqual({ toolCallId: "call_1", terminalIds: ["t3-term-9"] });
    expect(
      embeddedTerminalIdsFromSessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_2",
          title: "Tool",
          status: "pending",
        },
      }),
    ).toBeUndefined();
  });
});
