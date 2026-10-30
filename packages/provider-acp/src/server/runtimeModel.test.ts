import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/compat";

import {
  decideToolCallUpdateEmission,
  applyAcpAgentTerminalUpdate,
  acpContentBlockDisplayText,
  embeddedTerminalIdsFromSessionUpdate,
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionModelStateFromInitialize,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
  toolCallProgressLength,
  withTrackedPermissionToolCall,
  type AcpToolCallState,
} from "./runtimeModel.ts";

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
          kind: "read",
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
    expect(
      decideToolCallUpdateEmission({
        previous: created,
        next: cleared,
        lastEmittedDetailLength: 0,
        skippedSinceEmit: 0,
      }).emit,
    ).toBe(true);
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
    expect(idle.events[0]).toMatchObject({
      _tag: "UsageUpdated",
      usage: { usedTokens: 420 },
    });
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

  it("keeps the newest 16 MiB of ACP terminal output at a UTF-8 boundary", () => {
    const cap = 16 * 1024 * 1024;
    const chunk = (text: string | Uint8Array) => ({
      sessionUpdate: "terminal_output_chunk" as const,
      terminalId: "terminal-cap",
      data: Buffer.from(text).toString("base64"),
    });
    const seeded = applyAcpAgentTerminalUpdate(undefined, {
      sessionUpdate: "terminal_update",
      terminalId: "terminal-cap",
      output: { data: Buffer.from(`é${"a".repeat(cap - 3)}`).toString("base64") },
    });
    expect(seeded.outputBytes).toBe(cap - 1);

    // One byte over the cap falls inside "é", so the whole character is dropped.
    const trimmed = applyAcpAgentTerminalUpdate(seeded, chunk("bc"));
    expect(trimmed.output.length).toBe(cap - 1);
    expect(trimmed.output.slice(0, 2)).toBe("aa");
    expect(trimmed.output.slice(-3)).toBe("abc");
    expect(trimmed.outputBytes).toBe(cap - 1);

    const emoji = applyAcpAgentTerminalUpdate(trimmed, chunk("🙂"));
    expect(emoji.output.slice(-5)).toBe("abc🙂");
    expect(emoji.outputBytes).toBe(cap);
    expect(Buffer.byteLength(emoji.output)).toBe(cap);

    // Exit flushes an incomplete trailing character and trims again.
    const pending = applyAcpAgentTerminalUpdate(emoji, chunk(Buffer.from("🙂").subarray(0, 2)));
    const exited = applyAcpAgentTerminalUpdate(pending, {
      sessionUpdate: "terminal_update",
      terminalId: "terminal-cap",
      exitStatus: { exitCode: 1 },
    });
    expect(exited.output.slice(-4)).toBe("c🙂\uFFFD");
    expect(exited.outputBytes).toBe(Buffer.byteLength(exited.output));
    expect(exited.outputBytes).toBeLessThanOrEqual(cap);

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

  it("recovers T3 identity from acp-mcp-call fallback commands", () => {
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-1",
      kind: "execute",
      title: "Ran command",
      status: "in_progress",
    });

    expect(
      extractMcpToolCallIdentity(toolCall, {
        embeddedTerminalCommands: [
          '/usr/bin/node /srv/t3/bin.ts acp-mcp-call delegate_task {"task":"x"}',
        ],
      }),
    ).toEqual({ server: "t3-code", tool: "delegate_task", input: { task: "x" } });
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
    for (const title of ["t3-code/README.md", "t3-code_not_a_real_tool"]) {
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
