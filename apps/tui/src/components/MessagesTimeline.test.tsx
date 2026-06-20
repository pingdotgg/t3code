import { describe, expect, it } from "bun:test";
import { SyntaxStyle } from "@opentui/core";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { OrchestrationThread } from "../connection.ts";
import { MessagesTimeline } from "./MessagesTimeline.tsx";

// Component spec for the conversation header's plan/build indicator (^B).

function detail(interactionMode: "default" | "plan"): OrchestrationThread {
  return {
    id: "t1",
    title: "Thread one",
    interactionMode,
    runtimeMode: "full-access",
    updatedAt: "2026-06-19T00:00:00.000Z",
    session: { status: "idle" },
    latestTurn: null,
    messages: [],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
  } as unknown as OrchestrationThread;
}

async function headerFrame(mode: "default" | "plan"): Promise<string> {
  const ref = React.createRef<null>();
  const t = await testRender(
    <MessagesTimeline
      detail={detail(mode)}
      approvals={[]}
      approvalIndex={0}
      projectHint={null}
      width={80}
      height={10}
      syntaxStyle={SyntaxStyle.create()}
      scrollRef={ref as never}
    />,
    { width: 90, height: 12 },
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

describe("MessagesTimeline header", () => {
  it("Given a thread in plan mode, then the header shows 'plan'", async () => {
    expect(await headerFrame("plan")).toContain("plan");
  });

  it("Given a thread in default mode, then the header shows 'build'", async () => {
    expect(await headerFrame("default")).toContain("build");
  });
});

async function bodyFrame(
  over: Partial<OrchestrationThread>,
  approvals: ReadonlyArray<{ requestId: string; requestKind: string; detail?: string; createdAt: string }> = [],
  approvalIndex = 0,
): Promise<string> {
  const ref = React.createRef<null>();
  const full = { ...detail("default"), ...over } as unknown as OrchestrationThread;
  const t = await testRender(
    <MessagesTimeline
      detail={full}
      approvals={approvals as never}
      approvalIndex={approvalIndex}
      projectHint={null}
      width={88}
      height={20}
      syntaxStyle={SyntaxStyle.create()}
      scrollRef={ref as never}
    />,
    { width: 92, height: 24 },
  );
  await t.renderOnce();
  await t.flush();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

describe("MessagesTimeline body", () => {
  it("Given a tool activity, then it renders a tool-call row with the command", async () => {
    const frame = await bodyFrame({
      activities: [
        {
          id: "a1",
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran command",
          payload: { itemType: "command_execution", title: "Terminal", detail: "pnpm test" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-06-19T00:00:01.000Z",
        },
      ] as never,
    });
    expect(frame).toContain("Terminal");
    expect(frame).toContain("pnpm test");
  });

  it("Given a checkpoint for an assistant message, then it renders a changed-files summary", async () => {
    const frame = await bodyFrame({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "done",
          createdAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
        },
      ] as never,
      checkpoints: [
        {
          assistantMessageId: "m1",
          completedAt: "2026-06-19T00:00:01.000Z",
          files: [{ path: "src/app.ts", kind: "file", additions: 5, deletions: 2 }],
        },
      ] as never,
    });
    expect(frame).toContain("changed files (1)");
    expect(frame).toContain("src/app.ts");
    expect(frame).toContain("+5");
    expect(frame).toContain("-2");
  });

  it("Given messages across two turns, then a numbered turn separator is shown", async () => {
    const frame = await bodyFrame({
      messages: [
        { id: "m1", role: "user", text: "first", turnId: "t1", createdAt: "2026-06-19T00:00:00.000Z", streaming: false },
        { id: "m2", role: "user", text: "second", turnId: "t2", createdAt: "2026-06-19T00:00:02.000Z", streaming: false },
      ] as never,
    });
    expect(frame).toContain("turn 2");
  });

  it("Given a running turn, then it renders the working indicator", async () => {
    const frame = await bodyFrame({
      session: { status: "running" } as never,
      latestTurn: { state: "running", startedAt: "2026-06-19T00:00:00.000Z" } as never,
    });
    expect(frame).toContain("Working");
  });

  it("Given context-window usage, then it renders the meter in the header", async () => {
    const frame = await bodyFrame({
      activities: [
        {
          id: "c1",
          tone: "info",
          kind: "context-window.updated",
          summary: "ctx",
          payload: { usedTokens: 144_000, maxTokens: 200_000 },
          turnId: null,
          createdAt: "2026-06-19T00:00:01.000Z",
        },
      ] as never,
    });
    expect(frame).toContain("context");
    expect(frame).toContain("72%");
    expect(frame).toContain("144k/200k");
  });

  it("Given an actionable proposed plan, then it renders the plan card", async () => {
    const frame = await bodyFrame({
      proposedPlans: [
        {
          id: "pp1",
          turnId: null,
          planMarkdown: "# Migrate the parser\n\nRewrite the tokenizer.",
          implementedAt: null,
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
        },
      ] as never,
    });
    expect(frame).toContain("Migrate the parser");
    expect(frame).toContain("proposed plan");
    expect(frame).toContain("^Y implement");
  });

  it("Given several pending approvals, then it shows the count and highlights the selected one", async () => {
    const frame = await bodyFrame(
      {},
      [
        { requestId: "r1", requestKind: "command", detail: "rm -rf build", createdAt: "2026-06-19T00:00:00.000Z" },
        { requestId: "r2", requestKind: "file-change", detail: "src/app.ts", createdAt: "2026-06-19T00:00:01.000Z" },
      ],
      1,
    );
    expect(frame).toContain("(2 of 2)");
    expect(frame).toContain("↑/↓ select");
    // The second approval (index 1) is the active one.
    expect(frame).toContain("▸ file-change");
  });
});
