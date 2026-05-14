import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const scrollToEndSpy = vi.fn();
const getStateSpy = vi.fn(() => ({ isAtEnd: true }));

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  function LegendList(props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    ref?: React.Ref<LegendListRef>;
  }) {
    React.useImperativeHandle(
      props.ref,
      () =>
        ({
          scrollToEnd: scrollToEndSpy,
          getState: getStateSpy,
        }) as unknown as LegendListRef,
    );

    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  }

  return { LegendList };
});

import { MessagesTimeline } from "./MessagesTimeline";

const MESSAGE_CREATED_AT = "2026-04-13T12:00:00.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
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
    stickyUserMessageCount: 0,
    stickyUserMessageMaxLines: 2,
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
  {
    entryId = "entry-1",
    messageId = "message-1",
    createdAt = MESSAGE_CREATED_AT,
  }: {
    entryId?: string;
    messageId?: string;
    createdAt?: string;
  } = {},
) {
  return {
    id: entryId,
    kind: "message" as const,
    createdAt,
    message: {
      id: messageId as never,
      role: "user" as const,
      text,
      createdAt,
      streaming: false,
    },
  };
}

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
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

  it("shows a sticky user message only after its source row is above the transcript viewport", async () => {
    let sourceAboveViewport = true;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "legend-list") {
          return DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 240 });
        }
        if (this.dataset.messageId === "message-1") {
          return sourceAboveViewport
            ? DOMRect.fromRect({ x: 0, y: -80, width: 480, height: 60 })
            : DOMRect.fromRect({ x: 0, y: 80, width: 480, height: 60 });
        }
        return originalGetBoundingClientRect.call(this);
      },
    );

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        stickyUserMessageCount={1}
        stickyUserMessageMaxLines={2}
        timelineEntries={[buildUserTimelineEntry("Keep this request visible.")]}
      />,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: "Scroll to original user message" }))
        .toBeVisible();

      sourceAboveViewport = false;
      document.querySelector("[data-testid='legend-list']")?.dispatchEvent(new Event("scroll"));

      await expect
        .element(page.getByRole("button", { name: "Scroll to original user message" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("scrolls back to the original user message when the sticky copy is clicked", async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "legend-list") {
          return DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 240 });
        }
        if (this.dataset.messageId === "message-1") {
          return DOMRect.fromRect({ x: 0, y: -80, width: 480, height: 60 });
        }
        return originalGetBoundingClientRect.call(this);
      },
    );
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        stickyUserMessageCount={1}
        timelineEntries={[buildUserTimelineEntry("Jump back to this prompt.")]}
      />,
    );

    try {
      const stickyButton = page.getByRole("button", { name: "Scroll to original user message" });
      await expect.element(stickyButton).toBeVisible();
      await stickyButton.click();

      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    } finally {
      await screen.unmount();
    }
  });

  it("shows sticky metadata only on the newest visible sticky user message", async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === "legend-list") {
          return DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 240 });
        }
        if (this.dataset.messageId === "message-1" || this.dataset.messageId === "message-2") {
          return DOMRect.fromRect({ x: 0, y: -80, width: 480, height: 60 });
        }
        return originalGetBoundingClientRect.call(this);
      },
    );

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        stickyUserMessageCount={2}
        stickyUserMessageMaxLines={2}
        timelineEntries={[
          buildUserTimelineEntry("First sticky prompt.", {
            entryId: "entry-1",
            messageId: "message-1",
          }),
          buildUserTimelineEntry("Second sticky prompt.", {
            entryId: "entry-2",
            messageId: "message-2",
          }),
        ]}
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(document.querySelector("[data-sticky-user-message-id='message-1']")).not.toBeNull();
        expect(document.querySelector("[data-sticky-user-message-id='message-2']")).not.toBeNull();

        const metaRows = document.querySelectorAll("[data-sticky-user-message-meta='true']");
        expect(metaRows).toHaveLength(1);
        expect(
          metaRows[0]
            ?.closest("[data-sticky-user-message-id]")
            ?.getAttribute("data-sticky-user-message-id"),
        ).toBe("message-2");
      });
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
});
