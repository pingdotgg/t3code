import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { createRef } from "react";
import type { VirtualizedListHandle } from "../virtualization/VirtualizedList";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const scrollToEndSpy = vi.fn();
const getStateSpy = vi.fn(() => ({ isAtEnd: true }));

vi.mock("../virtualization/VirtualizedList", async () => {
  const React = await import("react");

  function VirtualizedList(props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string }; index: number }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    ref?: React.Ref<VirtualizedListHandle>;
    className?: string;
    style?: React.CSSProperties;
    "data-testid"?: string;
  }) {
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    React.useImperativeHandle(
      props.ref,
      () =>
        ({
          scrollToEnd: (options?: { animated?: boolean }) => {
            scrollToEndSpy(options);
            const node = rootRef.current;
            if (!node) return;
            node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
          },
          scrollToOffset: ({ offset }: { offset: number; animated?: boolean }) => {
            const node = rootRef.current;
            if (!node) return;
            node.scrollTop = offset;
          },
          scrollIndexIntoView: ({ index }: { index: number; animated?: boolean }) => {
            rootRef.current?.children.item(index)?.scrollIntoView({ block: "nearest" });
          },
          getScrollableNode: () => rootRef.current,
          getState: getStateSpy,
        }) as unknown as VirtualizedListHandle,
    );

    return (
      <div
        className={props.className}
        data-testid={props["data-testid"] ?? "virtualized-list"}
        ref={rootRef}
        style={{ ...props.style, minHeight: 720, overflowY: "auto" }}
      >
        {props.ListHeaderComponent}
        {props.data.map((item, index) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  }

  return { VirtualizedList };
});

import { MessagesTimeline } from "./MessagesTimeline";

const MESSAGE_CREATED_AT = "2026-04-13T12:00:00.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<VirtualizedListHandle | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(
  text: string,
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    previewUrl?: string;
  }>,
) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "message-1" as never,
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
      ...(attachments ? { attachments } : {}),
    },
  };
}

function buildAssistantTimelineEntry(
  text: string,
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    previewUrl?: string;
  }>,
) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "message-assistant-1" as never,
      role: "assistant" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
      ...(attachments ? { attachments } : {}),
    },
  };
}

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("renders activity rows instead of the empty placeholder when a thread has non-message timeline data", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a loading placeholder while an existing thread detail snapshot is still hydrating", async () => {
    const screen = await render(
      <MessagesTimeline {...buildProps()} timelineEntries={[]} isInitialLoading />,
    );

    try {
      await expect.element(page.getByText("Loading conversation...")).toBeVisible();
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "thinking",
                detail: "Inspecting repository state",
                tone: "thinking",
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("reports pointer, wheel, and touch scroll intent from the list surface", async () => {
    const onUserScrollIntent = vi.fn();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        onUserScrollIntent={onUserScrollIntent}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      const list = document.querySelector("[data-testid='messages-timeline-list']");
      expect(list).not.toBeNull();

      list?.parentElement?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      list?.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      list?.dispatchEvent(new Event("touchmove", { bubbles: true }));

      expect(onUserScrollIntent).toHaveBeenCalledTimes(3);
    } finally {
      await screen.unmount();
    }
  });

  it("requests manual older history from the older button", async () => {
    const onLoadOlderThreadDetail = vi.fn();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        hasOlderThreadDetail
        onLoadOlderThreadDetail={onLoadOlderThreadDetail}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await page.getByRole("button", { name: "Older" }).click();
      expect(onLoadOlderThreadDetail).toHaveBeenCalledWith();
    } finally {
      await screen.unmount();
    }
  });

  it("starts long user messages collapsed by default", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    try {
      const toggle = page.getByRole("button", { name: "Show full message" });
      await expect.element(toggle).toBeVisible();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");

      const messageBody = document.querySelector(
        "[data-user-message-body='true']",
      ) as HTMLDivElement | null;
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
      expect(messageBody?.className).toContain("max-h-44");
      expect(messageBody?.className).toContain("overflow-hidden");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("true");
      expect(messageBody?.style.maskImage).toContain("linear-gradient");
    } finally {
      await screen.unmount();
    }
  });

  it("expands and re-collapses long user messages from the toggle", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    try {
      const expandButton = page.getByRole("button", { name: "Show full message" });
      await expect.element(expandButton).toBeVisible();

      expect(document.body.textContent ?? "").toContain("deep hidden detail only after expand");

      await expandButton.click();

      const collapseButton = page.getByRole("button", { name: "Show less" });
      await expect.element(collapseButton).toBeVisible();
      await expect.element(collapseButton).toHaveAttribute("aria-expanded", "true");

      let messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("false");
      expect(messageBody?.className).not.toContain("max-h-44");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("false");
      expect((messageBody as HTMLDivElement | null)?.style.maskImage ?? "").toBe("");

      await collapseButton.click();

      await expect.element(page.getByRole("button", { name: "Show full message" })).toBeVisible();
      messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
      expect(messageBody?.className).toContain("max-h-44");
      expect(messageBody?.getAttribute("data-user-message-fade")).toBe("true");
      expect((messageBody as HTMLDivElement | null)?.style.maskImage).toContain("linear-gradient");
    } finally {
      await screen.unmount();
    }
  });

  it("starts the newest long user prompt collapsed", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText("latest long prompt"))]}
      />,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Show full message" })).toBeVisible();

      const messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.getAttribute("data-user-message-collapsed")).toBe("true");
    } finally {
      await screen.unmount();
    }
  });

  it("renders user image thumbnails and expands all previewable images", async () => {
    const props = buildProps();
    const onImageExpand = vi.fn();
    const screen = await render(
      <MessagesTimeline
        {...props}
        onImageExpand={onImageExpand}
        timelineEntries={[
          buildUserTimelineEntry("See these", [
            {
              type: "image",
              id: "image-1",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 4,
              previewUrl: "/attachments/image-1",
            },
            {
              type: "image",
              id: "image-2",
              name: "second.png",
              mimeType: "image/png",
              sizeBytes: 5,
              previewUrl: "/attachments/image-2",
            },
          ]),
        ]}
      />,
    );

    try {
      const firstImage = document.querySelector<HTMLImageElement>('img[alt="first.png"]');
      const secondImage = document.querySelector<HTMLImageElement>('img[alt="second.png"]');
      expect(firstImage?.getAttribute("src")).toBe("/attachments/image-1");
      expect(secondImage?.getAttribute("src")).toBe("/attachments/image-2");

      const secondPreviewButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Preview second.png"]',
      );
      expect(secondPreviewButton).not.toBeNull();
      secondPreviewButton?.click();

      expect(onImageExpand).toHaveBeenCalledWith({
        images: [
          { src: "/attachments/image-1", name: "first.png" },
          { src: "/attachments/image-2", name: "second.png" },
        ],
        index: 1,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders assistant image-only messages without the empty-response fallback", async () => {
    const props = buildProps();
    const onImageExpand = vi.fn();
    const screen = await render(
      <MessagesTimeline
        {...props}
        onImageExpand={onImageExpand}
        timelineEntries={[
          buildAssistantTimelineEntry("", [
            {
              type: "image",
              id: "assistant-image-1",
              name: "generated.png",
              mimeType: "image/png",
              sizeBytes: 4,
              previewUrl: "/attachments/assistant-image-1",
            },
          ]),
        ]}
      />,
    );

    try {
      await expect.element(page.getByAltText("generated.png")).toBeInTheDocument();
      await expect.element(page.getByText("(empty response)")).not.toBeInTheDocument();

      await page.getByRole("button", { name: "Preview generated.png" }).click();
      expect(onImageExpand).toHaveBeenCalledWith({
        images: [{ src: "/attachments/assistant-image-1", name: "generated.png" }],
        index: 0,
      });
    } finally {
      await screen.unmount();
    }
  });
});
