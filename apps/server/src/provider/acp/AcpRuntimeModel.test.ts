import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import {
  decideToolCallUpdateEmission,
  extractModelConfigId,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
  toolCallProgressLength,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

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

  it("extracts the model config id from typed ACP config options", () => {
    const modelConfigId = extractModelConfigId({
      sessionId: "session-1",
      configOptions: [
        {
          id: "approval",
          name: "Approval Mode",
          category: "permission",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Auto" }],
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modelConfigId).toBe("model");
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

  it("builds a synthetic load response from initialize model state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.models?.currentModelId).toBe("grok-build");
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });

  it("accepts initialize model descriptions with null", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build", description: null }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.models?.availableModels[0]?.description).toBeNull();
  });

  it("ignores malformed initialize model state in synthetic load responses", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [null],
        },
        modeState: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: 12 }],
        },
      },
    } as EffectAcpSchema.InitializeResponse);

    expect(response.models).toBeUndefined();
    expect(response.modes).toBeUndefined();
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });

  it("builds a synthetic load response with initialize mode state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "code", name: "Code" },
          ],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.modes?.currentModeId).toBe("code");
    expect(response.modes?.availableModes).toHaveLength(2);
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

  it("trims padded current mode updates before emitting a mode change", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: " code ",
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.modeId).toBe("code");
    expect(result.events).toEqual([
      {
        _tag: "ModeChanged",
        modeId: "code",
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

  it("bounds an oversized cumulative tool_call_update content buffer to a tail window", () => {
    // Mirrors Grok's ACP CLI resending the ENTIRE accumulated terminal output on every
    // tool_call_update notification instead of a delta (see upstream #6556).
    const hugeText = Array.from({ length: 2_000 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join(
      "\n",
    );
    expect(hugeText.length).toBeGreaterThan(60_000);

    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        // Real ACP `tool_call_update` deltas typically omit `title` (already established by
        // the initial `tool_call`); that is also the shape that surfaces raw content as detail.
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
    // 8000 chars of tail plus the truncation marker, regardless of input size.
    expect(detail.length).toBe(8_028);
    expect(detail.startsWith("[Earlier output truncated]")).toBe(true);
    expect(detail.endsWith(hugeText.slice(-100))).toBe(true);

    // The raw payload threaded through for logging/persistence must not smuggle the full
    // cumulative buffer back in either.
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
      // Grok resends the FULL accumulated buffer, not a delta, on every redraw.
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

    // The flood as the CLI sends it: 1000 cumulative redraws, ~31.6 MB of JSON.
    expect(notificationBytes).toBeGreaterThan(31_000_000);

    // 1000 cumulative redraws collapse into a fixed, small number of runtime events...
    expect(emittedCount).toBe(114);
    // ...each individually bounded, no matter how long the tool call runs...
    expect(largestEmittedEventBytes).toBeLessThan(25_000);
    // ...so the whole flooding tool call costs ~2.5 MB of runtime events instead of ~31.6 MB.
    expect(emittedBytes).toBeLessThan(2_600_000);
    // ...while the FINAL state (forced by the completed status) still reflects the real,
    // latest output rather than a stale coalesced value.
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

  it("keeps a retained tail on the original text entries around non-text content", () => {
    const prefix = "a".repeat(4_000);
    const suffix = "b".repeat(5_000);
    const { events } = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        kind: "edit",
        status: "in_progress",
        content: [
          { type: "content", content: { type: "text", text: prefix } },
          { type: "diff", path: "/repo/file.ts", oldText: "before", newText: "after" },
          { type: "content", content: { type: "text", text: suffix } },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const event = events[0];
    if (event?._tag !== "ToolCallUpdated") {
      throw new Error("expected a ToolCallUpdated event");
    }
    const content = event.toolCall.data.content as ReadonlyArray<EffectAcpSchema.ToolCallContent>;
    expect(content).toHaveLength(3);
    const firstText = content[0];
    if (firstText?.type !== "content" || firstText.content.type !== "text") {
      throw new Error("expected a bounded prefix text entry");
    }
    expect(firstText.content.text.startsWith("[Earlier output truncated]")).toBe(true);
    expect(firstText.content.text.endsWith("a".repeat(100))).toBe(true);
    expect(content[1]).toEqual({
      type: "diff",
      path: "/repo/file.ts",
      oldText: "before",
      newText: "after",
    });
    expect(content[2]).toEqual({
      type: "content",
      content: { type: "text", text: suffix },
    });
  });

  it("bounds oversized whitespace-only tool call content that has no trimmed text", () => {
    // Whitespace-only entries are skipped when extracting display text (`chunks.length === 0`)
    // and used to be returned unchanged, which let a redrawing terminal persist unbounded
    // buffers on `toolCall.data.content` and `rawPayload`.
    const hugeWhitespace = " \n\t".repeat(30_000);
    expect(hugeWhitespace.length).toBeGreaterThan(60_000);

    const { events } = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        kind: "other",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: hugeWhitespace } }],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const event = events[0];
    if (event?._tag !== "ToolCallUpdated") {
      throw new Error("expected a ToolCallUpdated event");
    }

    expect(event.toolCall.detail).toBeUndefined();
    const content = event.toolCall.data.content as ReadonlyArray<EffectAcpSchema.ToolCallContent>;
    const textEntry = content[0];
    if (textEntry?.type !== "content" || textEntry.content.type !== "text") {
      throw new Error("expected a bounded text entry");
    }
    expect(textEntry.content.text.length).toBeLessThan(8_100);
    expect(textEntry.content.text.startsWith("[Earlier output truncated]")).toBe(true);

    const rawUpdate = (
      event.rawPayload as {
        readonly update: {
          readonly content: ReadonlyArray<{ readonly content: { text: string } }>;
        };
      }
    ).update;
    expect(rawUpdate.content[0]?.content.text.length).toBeLessThan(8_100);
    expect(JSON.stringify(event).length).toBeLessThan(hugeWhitespace.length);
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

    it("emits the first in-progress tool_call even when it has no detail", () => {
      expect(
        decideToolCallUpdateEmission({
          previous: undefined,
          next: { toolCallId: "tool-1", title: "Grok Tool", status: "pending", data: {} },
          lastEmittedDetailLength: undefined,
          skippedSinceEmit: 0,
        }),
      ).toEqual({ emit: true, skippedSinceEmit: 0 });
    });

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

    it("skips updates whose bounded detail did not change", () => {
      const previous = toolCall("frame 1", "inProgress");
      expect(
        decideToolCallUpdateEmission({
          previous,
          next: previous,
          lastEmittedDetailLength: 7,
          skippedSinceEmit: 0,
        }),
      ).toEqual({ emit: false, skippedSinceEmit: 0 });
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

    it("emits pending to inProgress status changes even when detail and output are unchanged", () => {
      expect(
        decideToolCallUpdateEmission({
          previous: toolCall("same", "pending"),
          next: toolCall("same", "inProgress"),
          lastEmittedDetailLength: 4,
          skippedSinceEmit: 0,
        }),
      ).toEqual({ emit: true, skippedSinceEmit: 0 });
    });

    it("emits immediately when the title changes, even with no growth", () => {
      const decision = decideToolCallUpdateEmission({
        previous: { toolCallId: "tool-1", title: "Reading file", detail: "x", data: {} },
        next: { toolCallId: "tool-1", title: "Ran command", detail: "x", data: {} },
        lastEmittedDetailLength: 1,
        skippedSinceEmit: 0,
      });
      expect(decision).toEqual({ emit: true, skippedSinceEmit: 0 });
    });

    it("coalesces small deltas but forces an emission after the coalesce limit", () => {
      let lastEmittedDetailLength: number | undefined = 0;
      let skippedSinceEmit = 0;
      const emissions: Array<boolean> = [];
      let previous: AcpToolCallState | undefined;

      for (let i = 1; i <= 12; i += 1) {
        // Grows by 1 char per update — well under the 256-char growth threshold, so this
        // exercises the coalesce-count fallback rather than the growth-based trigger.
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

      // First update always emits (no previous state yet); after that, small per-update
      // growth should be coalesced until the coalesce limit forces a periodic emission.
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
});
