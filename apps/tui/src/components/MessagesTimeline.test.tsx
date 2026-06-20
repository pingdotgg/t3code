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
  } as unknown as OrchestrationThread;
}

async function headerFrame(mode: "default" | "plan"): Promise<string> {
  const ref = React.createRef<null>();
  const t = await testRender(
    <MessagesTimeline
      detail={detail(mode)}
      approvals={[]}
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

async function bodyFrame(over: Partial<OrchestrationThread>): Promise<string> {
  const ref = React.createRef<null>();
  const full = { ...detail("default"), ...over } as unknown as OrchestrationThread;
  const t = await testRender(
    <MessagesTimeline
      detail={full}
      approvals={[]}
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

  it("Given a running turn, then it renders the working indicator", async () => {
    const frame = await bodyFrame({
      session: { status: "running" } as never,
      latestTurn: { state: "running", startedAt: "2026-06-19T00:00:00.000Z" } as never,
    });
    expect(frame).toContain("Working");
  });
});
