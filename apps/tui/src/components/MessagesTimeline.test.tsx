import { describe, expect, it } from "bun:test";
import { SyntaxStyle } from "@opentui/core";
import { MockTreeSitterClient } from "@opentui/core/testing";
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
  it("Given a message with an image attachment, then it shows a link to the file", async () => {
    const full = {
      ...detail("default"),
      messages: [
        {
          id: "u1",
          role: "user",
          text: "look at this",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
          attachments: [
            { type: "image", id: "att1", name: "diagram.png", mimeType: "image/png", sizeBytes: 24_576 },
          ],
        },
      ],
    } as unknown as OrchestrationThread;
    const ref = React.createRef<null>();
    const t = await testRender(
      <MessagesTimeline
        detail={full}
        approvals={[]}
        approvalIndex={0}
        projectHint={null}
        width={88}
        height={20}
        syntaxStyle={SyntaxStyle.create()}
        scrollRef={ref as never}
        getAttachmentUrl={async () => "https://srv/assets/att1.png"}
      />,
      { width: 92, height: 24 },
    );
    // Let the async URL resolve and repaint.
    for (let i = 0; i < 6; i += 1) {
      await t.renderOnce();
      await t.flush();
    }
    const frame = t.captureCharFrame();
    expect(frame).toContain("diagram.png");
    expect(frame).toContain("24 KB");
    expect(frame).toContain("att1.png"); // the resolved link is shown
    t.renderer.destroy();
  });

  it("Given an attachment whose link can't be resolved, then it shows it as unavailable (not stuck resolving)", async () => {
    const full = {
      ...detail("default"),
      messages: [
        {
          id: "u1",
          role: "user",
          text: "look",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
          attachments: [
            { type: "image", id: "att1", name: "broken.png", mimeType: "image/png", sizeBytes: 1024 },
          ],
        },
      ],
    } as unknown as OrchestrationThread;
    const ref = React.createRef<null>();
    const t = await testRender(
      <MessagesTimeline
        detail={full}
        approvals={[]}
        approvalIndex={0}
        projectHint={null}
        width={88}
        height={20}
        syntaxStyle={SyntaxStyle.create()}
        scrollRef={ref as never}
        getAttachmentUrl={async () => null}
      />,
      { width: 92, height: 24 },
    );
    for (let i = 0; i < 6; i += 1) {
      await t.renderOnce();
      await t.flush();
    }
    const frame = t.captureCharFrame();
    expect(frame).toContain("broken.png");
    expect(frame).toContain("link unavailable");
    expect(frame).not.toContain("resolving");
    t.renderer.destroy();
  });

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

  it("Given a checkpoint for an assistant message, then it renders a changed-files tree", async () => {
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
    // Rendered as a directory tree: a "src/" folder row with the "app.ts" file under it.
    expect(frame).toContain("src/");
    expect(frame).toContain("app.ts");
    expect(frame).toContain("collapse all");
    expect(frame).toContain("+5");
    expect(frame).toContain("-2");
  });

  it("Given a file row, then clicking it opens the diff scoped to that file", async () => {
    const opened: Array<[number, string | undefined]> = [];
    const full = {
      ...detail("default"),
      messages: [
        { id: "m1", role: "assistant", text: "done", createdAt: "2026-06-19T00:00:00.000Z", streaming: false },
      ],
      checkpoints: [
        {
          assistantMessageId: "m1",
          checkpointTurnCount: 7,
          completedAt: "2026-06-19T00:00:01.000Z",
          files: [{ path: "src/app.ts", kind: "file", additions: 5, deletions: 2 }],
        },
      ],
    } as unknown as OrchestrationThread;
    const ref = React.createRef<null>();
    const t = await testRender(
      <MessagesTimeline
        detail={full}
        approvals={[]}
        approvalIndex={0}
        projectHint={null}
        width={88}
        height={20}
        syntaxStyle={SyntaxStyle.create()}
        scrollRef={ref as never}
        onOpenDiff={(turnCount, filePath) => opened.push([turnCount, filePath])}
      />,
      { width: 92, height: 24 },
    );
    await t.renderOnce();
    await t.flush();
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("app.ts"));
    const col = (lines[row] ?? "").indexOf("app.ts");
    await t.mockMouse.click(col, row);
    await t.flush();
    expect(opened).toEqual([[7, "src/app.ts"]]);
    t.renderer.destroy();
  });

  it("Given the changed-files tree, then 'collapse all' hides the files under their folders", async () => {
    const full = {
      ...detail("default"),
      messages: [
        { id: "m1", role: "assistant", text: "done", createdAt: "2026-06-19T00:00:00.000Z", streaming: false },
      ],
      checkpoints: [
        {
          assistantMessageId: "m1",
          checkpointTurnCount: 4,
          completedAt: "2026-06-19T00:00:01.000Z",
          files: [
            { path: "src/app.ts", kind: "file", additions: 5, deletions: 2 },
            { path: "src/util/clip.ts", kind: "file", additions: 1, deletions: 0 },
          ],
        },
      ],
    } as unknown as OrchestrationThread;
    const ref = React.createRef<null>();
    const t = await testRender(
      <MessagesTimeline
        detail={full}
        approvals={[]}
        approvalIndex={0}
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
    expect(t.captureCharFrame()).toContain("app.ts");
    const lines = t.captureCharFrame().split("\n");
    const headerRow = lines.findIndex((line) => line.includes("collapse all"));
    const col = (lines[headerRow] ?? "").indexOf("collapse all") + 2;
    await t.mockMouse.click(col, headerRow);
    await t.flush();
    // Every directory is folded, so the file leaves are gone.
    expect(t.captureCharFrame()).not.toContain("app.ts");
    t.renderer.destroy();
  });

  it("Given onOpenDiff, then the changed-files summary is clickable and opens that turn", async () => {
    const openedTurns: number[] = [];
    const full = {
      ...detail("default"),
      messages: [
        { id: "m1", role: "assistant", text: "done", createdAt: "2026-06-19T00:00:00.000Z", streaming: false },
      ],
      checkpoints: [
        {
          assistantMessageId: "m1",
          checkpointTurnCount: 7,
          completedAt: "2026-06-19T00:00:01.000Z",
          files: [{ path: "src/app.ts", kind: "file", additions: 5, deletions: 2 }],
        },
      ],
    } as unknown as OrchestrationThread;
    const ref = React.createRef<null>();
    const t = await testRender(
      <MessagesTimeline
        detail={full}
        approvals={[]}
        approvalIndex={0}
        projectHint={null}
        width={88}
        height={20}
        syntaxStyle={SyntaxStyle.create()}
        scrollRef={ref as never}
        onOpenDiff={(turnCount) => openedTurns.push(turnCount)}
      />,
      { width: 92, height: 24 },
    );
    await t.renderOnce();
    await t.flush();
    const lines = t.captureCharFrame().split("\n");
    expect(lines.some((line) => line.includes("▸ diff"))).toBe(true);
    const row = lines.findIndex((line) => line.includes("changed files"));
    expect(row).toBeGreaterThanOrEqual(0);
    await t.mockMouse.click(3, row);
    await t.flush();
    expect(openedTurns).toEqual([7]);
    t.renderer.destroy();
  });

  it("Given a user message in the real flex-row layout, its markdown paints right-aligned", async () => {
    // The bug: inside a flexGrow→scrollbox the cross-size is auto, so width="100%"
    // / alignSelf collapse and the bubble vanishes. Reproduce the real ChatView
    // nesting (sidebar + grown timeline) and paint the markdown via a mock
    // tree-sitter client (the harness has no worker).
    const mock = new MockTreeSitterClient({ autoResolveTimeout: 0 });
    mock.setMockResult({ highlights: [] });
    const ref = React.createRef<null>();
    const chatWidth = 92 - 30 - 4;
    const full = {
      ...detail("default"),
      messages: [
        { id: "a1", role: "assistant", text: "looking into it", createdAt: "2026-06-19T00:00:00.000Z", streaming: false },
        { id: "u1", role: "user", text: "ship it please", createdAt: "2026-06-19T00:00:01.000Z", streaming: false },
      ],
    } as unknown as OrchestrationThread;
    const t = await testRender(
      <box flexDirection="column" width={92} height={24}>
        <box height={20} flexShrink={0} flexDirection="row">
          <box width={30} height={20} border borderStyle="rounded">
            <text>sidebar</text>
          </box>
          <MessagesTimeline
            detail={full}
            approvals={[]}
            approvalIndex={0}
            projectHint={null}
            width={chatWidth}
            height={20}
            syntaxStyle={SyntaxStyle.create()}
            scrollRef={ref as never}
            treeSitterClient={mock}
          />
        </box>
      </box>,
      { width: 92, height: 26 },
    );
    for (let i = 0; i < 8; i += 1) {
      await t.renderOnce();
      try {
        mock.resolveAllHighlightOnce();
      } catch {
        // no pending highlight this pass
      }
      await t.flush();
    }
    const frame = t.captureCharFrame();
    // The user's markdown actually paints — and the old role labels are gone.
    expect(frame).toContain("ship it please");
    expect(frame).not.toContain("you");
    // The bubble is right-aligned: its text sits well to the right of the timeline.
    const userLine = frame.split("\n").find((line) => line.includes("ship it please")) ?? "";
    expect(userLine.indexOf("ship it please")).toBeGreaterThan(60);
    t.renderer.destroy();
  });

  it("Given a settled turn, then its tool work folds behind a 'Worked for' row", async () => {
    const frame = await bodyFrame({
      messages: [
        { id: "u1", role: "user", text: "go", turnId: "t1", createdAt: "2026-06-19T00:00:00.000Z", updatedAt: "2026-06-19T00:00:00.000Z", streaming: false },
        { id: "m1", role: "assistant", text: "done", turnId: "t1", createdAt: "2026-06-19T00:00:05.000Z", updatedAt: "2026-06-19T00:00:05.000Z", streaming: false },
      ] as never,
      activities: [
        {
          id: "a1",
          tone: "tool",
          kind: "tool.completed",
          summary: "step",
          payload: { itemType: "command_execution", title: "cmd-folded", detail: "do x" },
          turnId: "t1",
          sequence: 1,
          createdAt: "2026-06-19T00:00:01.000Z",
        },
      ] as never,
    });
    // The settled turn's work collapses behind a "Worked for" summary; the tool
    // row itself is hidden until the fold is expanded.
    expect(frame).toContain("Worked for");
    expect(frame).not.toContain("cmd-folded");
  });

  it("Given a run of tool calls in the active turn, then only the most recent shows with a '+N previous tool calls' expander", async () => {
    const activities = Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      tone: "tool",
      kind: "tool.completed",
      summary: `step ${i}`,
      payload: { itemType: "command_execution", title: `cmd-${i}`, detail: `do ${i}` },
      turnId: "t1",
      sequence: i,
      createdAt: `2026-06-19T00:00:0${i}.000Z`,
    })) as never;
    // A running turn stays unfolded, so the work group's own collapsing shows.
    const frame = await bodyFrame({
      activities,
      latestTurn: {
        turnId: "t1",
        state: "running",
        startedAt: "2026-06-19T00:00:00.000Z",
        completedAt: null,
      } as never,
    });
    // Only the most recent tool call is visible; the rest collapse behind a count.
    expect(frame).toContain("cmd-5");
    expect(frame).not.toContain("cmd-0");
    expect(frame).toContain("+5 previous tool calls");
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
