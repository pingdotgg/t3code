import { describe, expect, it } from "bun:test";
import { CliRenderEvents, getLinkId, type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import { MockTreeSitterClient, setRendererCapabilities } from "@opentui/core/testing";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";
import { installKittyImageExtension } from "@t3tools/opentui-image";

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
  approvals: ReadonlyArray<{
    requestId: string;
    requestKind: string;
    detail?: string;
    createdAt: string;
  }> = [],
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
  it("Given a bare URL in a message, then the rendered URL cells carry an OSC 8 link", async () => {
    const url = "https://example.com/docs?q=timeline";
    const mock = new MockTreeSitterClient({ autoResolveTimeout: 0 });
    mock.setMockResult({
      highlights: [[6, 6 + url.length, "string.special.url"]],
    });
    const full = {
      ...detail("default"),
      messages: [
        {
          id: "a1",
          role: "assistant",
          text: `Open ${url}.`,
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
          attachments: [],
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
        treeSitterClient={mock}
      />,
      { width: 92, height: 24 },
    );
    for (let i = 0; i < 6; i += 1) {
      await t.renderOnce();
      mock.resolveAllHighlightOnce();
      await t.flush();
    }

    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes(url));
    const column = row >= 0 ? (lines[row]?.indexOf(url) ?? -1) : -1;
    expect(row).toBeGreaterThanOrEqual(0);
    expect(column).toBeGreaterThanOrEqual(0);
    const buffer = t.renderer.currentRenderBuffer;
    const linkedCells = Array.from(
      buffer.buffers.attributes.slice(
        row * buffer.width + column,
        row * buffer.width + column + url.length,
      ),
    ).filter((attributes) => getLinkId(attributes) > 0);
    expect(linkedCells).toHaveLength(url.length);
    t.renderer.destroy();
  });

  it("Given Kitty graphics are unavailable, then an image attachment remains a file link", async () => {
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
            {
              type: "image",
              id: "att1",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 24_576,
            },
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

  it("Given Kitty graphics are available, then an image attachment renders inline", async () => {
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
            {
              type: "image",
              id: "att1",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
        },
      ],
    } as unknown as OrchestrationThread;
    const ref = React.createRef<null>();
    const writes: string[] = [];
    const loadedUrls: string[] = [];
    const openedImages: string[] = [];
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
        getAttachmentImage={async (_attachmentId, url) => {
          loadedUrls.push(url);
          return {
            data: new Uint8Array([255, 0, 0, 255]),
            imageWidth: 1,
            imageHeight: 1,
          };
        }}
        onOpenImage={(preview) => openedImages.push(preview.name)}
      />,
      { width: 92, height: 24 },
    );
    installKittyImageExtension(t.renderer, {
      writer: { write: (value) => writes.push(value) },
    });
    const capabilities = setRendererCapabilities(t.renderer, { kitty_graphics: true });
    t.renderer.emit(CliRenderEvents.CAPABILITIES, capabilities);
    for (let i = 0; i < 8; i += 1) {
      await t.renderOnce();
      await t.flush();
    }

    expect(loadedUrls).toEqual(["https://srv/assets/att1.png"]);
    expect(writes.join("")).toContain("a=T");
    const frame = t.captureCharFrame();
    expect(frame).toContain("diagram.png");
    const metadataRow = frame.split("\n").findIndex((line) => line.includes("diagram.png"));
    expect(metadataRow).toBeGreaterThanOrEqual(0);
    await t.mockMouse.click(2, metadataRow + 1);
    expect(openedImages).toEqual(["diagram.png"]);
    t.renderer.destroy();
  });

  it("Given an inline image, when the timeline scrolls, then it uses a placeholder until scrolling settles", async () => {
    const full = {
      ...detail("default"),
      messages: [
        {
          id: "u1",
          role: "user",
          text: "scroll past this",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
          attachments: [
            {
              type: "image",
              id: "att1",
              name: "large-diagram.png",
              mimeType: "image/png",
              sizeBytes: 720_000,
            },
          ],
        },
      ],
    } as unknown as OrchestrationThread;
    const ref = React.createRef<null>();
    const writes: string[] = [];
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
        getAttachmentImage={async () => ({
          data: new Uint8Array(600 * 300 * 4),
          imageWidth: 600,
          imageHeight: 300,
        })}
      />,
      { width: 92, height: 24 },
    );
    const manager = installKittyImageExtension(t.renderer, {
      writer: { write: (value) => writes.push(value) },
    });
    const capabilities = setRendererCapabilities(t.renderer, { kitty_graphics: true });
    t.renderer.emit(CliRenderEvents.CAPABILITIES, capabilities);
    for (let i = 0; i < 8; i += 1) {
      await t.renderOnce();
      await t.flush();
    }
    const metadataRow = t
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("large-diagram.png"));
    expect(metadataRow).toBeGreaterThanOrEqual(0);
    expect(writes.join("")).toContain("a=T");

    await t.mockMouse.scroll(2, metadataRow + 2, "up");
    await t.renderOnce();

    expect(manager.isScrollPaused).toBe(true);
    expect(writes.at(-1)).toContain("a=d");
    expect(t.captureCharFrame()).toContain("[ image paused while scrolling ]");

    manager.resumeAfterScroll();
    await t.renderOnce();

    expect(manager.isScrollPaused).toBe(false);
    expect(writes.at(-1)).toContain("a=T");
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
            {
              type: "image",
              id: "att1",
              name: "broken.png",
              mimeType: "image/png",
              sizeBytes: 1024,
            },
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
        {
          id: "m1",
          role: "assistant",
          text: "done",
          createdAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
        },
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
        {
          id: "m1",
          role: "assistant",
          text: "done",
          createdAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
        },
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
        {
          id: "m1",
          role: "assistant",
          text: "done",
          createdAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
        },
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
        {
          id: "a1",
          role: "assistant",
          text: "looking into it",
          createdAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
        },
        {
          id: "u1",
          role: "user",
          text: "ship it please",
          createdAt: "2026-06-19T00:00:01.000Z",
          streaming: false,
        },
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
    const bubbleTop =
      frame.split("\n").find((line) => line.indexOf("╭", 40) >= 0 && line.lastIndexOf("╮") > 40) ??
      "";
    expect(bubbleTop).not.toBe("");
    expect(bubbleTop.lastIndexOf("╮")).toBeLessThan(91);
    t.renderer.destroy();
  });

  it("Given a user message beyond the web UI line limit, then it starts collapsed", async () => {
    const frame = await bodyFrame({
      messages: [
        {
          id: "u-long",
          role: "user",
          text: Array.from({ length: 10 }, (_, index) =>
            index === 9 ? "TAIL MUST STAY HIDDEN" : `prompt line ${index + 1}`,
          ).join("\n"),
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
          attachments: [],
        },
      ] as never,
    });
    expect(frame).toContain("Show full message");
    expect(frame).not.toContain("TAIL MUST STAY HIDDEN");
  });

  it("Given mixed wide messages, when the timeline is scrolled, then assistant text keeps its left edge", async () => {
    const mock = new MockTreeSitterClient({ autoResolveTimeout: 0 });
    mock.setMockResult({ highlights: [] });
    const ref = React.createRef<ScrollBoxRenderable>();
    const full = {
      ...detail("default"),
      messages: [
        {
          id: "u-wide",
          role: "user",
          text: [
            "Investigate this payload:",
            "{",
            '  "active": true,',
            '  "run_id": "1d2439d5f501471da80c60f576a9f7ed",',
            '  "merchant_id": "019c87a7-84f2-7073-81c7-6fbb7663c2df",',
            '  "location_id": "019c87a7-84f2-7073-81c8-22041002adbd",',
            '  "padding": true,',
            '  "more_padding": true,',
            '  "still_more_padding": true',
            "}",
          ].join("\n"),
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
          attachments: [],
        },
        {
          id: "a-left-edge",
          role: "assistant",
          text: "LEFT EDGE MUST STAY VISIBLE, and the pending translation keeps the aggregate run active. I am tracing why the jobs remain running after the timeout.",
          createdAt: "2026-06-19T00:00:01.000Z",
          updatedAt: "2026-06-19T00:00:01.000Z",
          streaming: false,
          attachments: [],
        },
        {
          id: "u-short",
          role: "user",
          text: "Kill it and let's fix it in code",
          createdAt: "2026-06-19T00:00:02.000Z",
          updatedAt: "2026-06-19T00:00:02.000Z",
          streaming: false,
          attachments: [],
        },
        {
          id: "a-tail",
          role: "assistant",
          text: "TAIL LEFT EDGE also remains visible after the later right-aligned prompt.",
          createdAt: "2026-06-19T00:00:03.000Z",
          updatedAt: "2026-06-19T00:00:03.000Z",
          streaming: false,
          attachments: [],
        },
      ],
    } as unknown as OrchestrationThread;
    const t = await testRender(
      <MessagesTimeline
        detail={full}
        approvals={[]}
        approvalIndex={0}
        projectHint={null}
        width={60}
        height={30}
        syntaxStyle={SyntaxStyle.create()}
        scrollRef={ref}
        treeSitterClient={mock}
      />,
      { width: 60, height: 30 },
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
    ref.current?.scrollTo({ x: 20, y: 7 });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    const userRow = ref.current?.getRenderable("timeline-row-u-wide");
    const assistantRow = ref.current?.getRenderable("timeline-row-a-left-edge");
    const viewportRight = (ref.current?.viewport.x ?? 0) + (ref.current?.viewport.width ?? 0);
    expect(ref.current?.scrollLeft).toBe(0);
    expect((userRow?.x ?? 0) + (userRow?.width ?? 0)).toBeLessThanOrEqual(viewportRight);
    expect(assistantRow?.x).toBe(ref.current?.viewport.x);
    expect(assistantRow?.width).toBe(ref.current?.viewport.width);
    expect(frame).toContain("LEFT EDGE MUST STAY VISIBLE");
    t.renderer.destroy();
  });

  it("Given a settled turn, then its tool work folds behind a 'Worked for' row", async () => {
    const frame = await bodyFrame({
      messages: [
        {
          id: "u1",
          role: "user",
          text: "go",
          turnId: "t1",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
          streaming: false,
        },
        {
          id: "m1",
          role: "assistant",
          text: "done",
          turnId: "t1",
          createdAt: "2026-06-19T00:00:05.000Z",
          updatedAt: "2026-06-19T00:00:05.000Z",
          streaming: false,
        },
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
        {
          requestId: "r1",
          requestKind: "command",
          detail: "rm -rf build",
          createdAt: "2026-06-19T00:00:00.000Z",
        },
        {
          requestId: "r2",
          requestKind: "file-change",
          detail: "src/app.ts",
          createdAt: "2026-06-19T00:00:01.000Z",
        },
      ],
      1,
    );
    expect(frame).toContain("(2 of 2)");
    expect(frame).toContain("↑/↓ select");
    // The second approval (index 1) is the active one.
    expect(frame).toContain("▸ file-change");
  });
});
