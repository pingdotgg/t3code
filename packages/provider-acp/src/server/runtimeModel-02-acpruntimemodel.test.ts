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
  it("trims full ACP terminal output by a further 1 MiB at a UTF-8 boundary", () => {
    const cap = 16 * 1024 * 1024;
    const step = 1024 * 1024;
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

    // The cut at one byte past the cap plus 1 MiB falls inside "é", so the whole character goes.
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

