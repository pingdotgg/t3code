import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { getVscodeIconUrlForEntry } from "../../vscode-icons";

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
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
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

function buildUserTimelineEntry(text: string) {
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
    },
  };
}

function buildAssistantTimelineEntry(text: string) {
  return {
    id: "entry-assistant-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "message-assistant-1" as never,
      role: "assistant" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
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
              label: "read files",
              detail: "Inspecting repository state",
              tone: "tool",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Inspecting repository state")).toBeVisible();
      expect(document.querySelector('[data-testid="legend-list"] [title]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("uses accessible tooltips instead of native titles for work entry details", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        workspaceRoot="/repo"
        timelineEntries={[
          {
            id: "work-command",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-command",
              createdAt: MESSAGE_CREATED_AT,
              label: "command",
              detail: "Inspecting generated output",
              command: "git diff -- apps/web/src/components/ChatMarkdown.tsx",
              rawCommand: "git diff -- apps/web/src/components/ChatMarkdown.tsx --stat",
              changedFiles: ["/repo/apps/web/src/components/ChatMarkdown.tsx"],
              tone: "tool",
            },
          },
        ]}
      />,
    );

    try {
      expect(document.querySelector('[data-testid="legend-list"] [title]')).toBeNull();

      const commandTrigger = page.getByLabelText(
        "Command - git diff -- apps/web/src/components/ChatMarkdown.tsx",
      );
      await commandTrigger.hover();
      await vi.waitFor(() => {
        const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
        expect(tooltip?.textContent).toContain(
          "git diff -- apps/web/src/components/ChatMarkdown.tsx --stat",
        );
      });

      const fileTrigger = page.getByLabelText("repo/apps/web/src/components/ChatMarkdown.tsx", {
        exact: true,
      });
      await fileTrigger.hover();
      await vi.waitFor(() => {
        const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
        expect(tooltip?.textContent).toContain("apps/web/src/components/ChatMarkdown.tsx");
      });
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
                label: "read files",
                detail: "Inspecting repository state",
                tone: "tool",
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Inspecting repository state")).toBeVisible();
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

  it("renders user messages as markdown with chat-style line breaks", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            "## Plan\nuse **bold** and [a link](https://example.com)\nsecond line",
          ),
        ]}
      />,
    );

    try {
      await expect.element(page.getByRole("heading", { level: 2, name: "Plan" })).toBeVisible();
      await expect
        .element(page.getByRole("link", { name: "a link" }))
        .toHaveAttribute("href", "https://example.com");

      const messageBody = document.querySelector("[data-user-message-body='true']");
      expect(messageBody?.querySelector("strong")?.textContent).toBe("bold");
      // remark-breaks: the single newline between the inline runs is a <br>.
      expect(messageBody?.querySelectorAll("p br").length).toBe(1);
    } finally {
      await screen.unmount();
    }
  });

  it("renders markdown file tags in user and assistant messages", async () => {
    const fileLink = "[package.json](path/to/package.json)";
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        markdownCwd="/repo/project"
        timelineEntries={[
          buildUserTimelineEntry(`Review ${fileLink}`),
          buildAssistantTimelineEntry(`I reviewed ${fileLink}`),
        ]}
      />,
    );

    try {
      const userFileLink = document.querySelector(
        '[data-message-role="user"] .chat-markdown-file-link',
      );
      const assistantFileLink = document.querySelector(
        '[data-message-role="assistant"] .chat-markdown-file-link',
      );

      expect(userFileLink?.textContent).toContain("package.json");
      expect(userFileLink?.getAttribute("href")).toBe("/repo/project/path/to/package.json");
      expect(assistantFileLink?.textContent).toContain("package.json");
      expect(assistantFileLink?.getAttribute("href")).toBe("/repo/project/path/to/package.json");
    } finally {
      await screen.unmount();
    }
  });

  it("uses the file path without line suffix for markdown file tag icons", async () => {
    const fileLink = "[package.json](path/to/package.json:25)";
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        markdownCwd="/repo/project"
        timelineEntries={[buildAssistantTimelineEntry(`Updated ${fileLink}`)]}
      />,
    );

    try {
      const assistantFileLink = document.querySelector(
        '[data-message-role="assistant"] .chat-markdown-file-link',
      );
      const icon = assistantFileLink?.querySelector("img");

      expect(assistantFileLink?.textContent).toContain("package.json");
      expect(assistantFileLink?.textContent).toContain("L25");
      expect(assistantFileLink?.getAttribute("href")).toBe("/repo/project/path/to/package.json:25");
      expect(icon?.getAttribute("src")).toBe(
        getVscodeIconUrlForEntry("/repo/project/path/to/package.json", "file", "dark"),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("folds settled-turn work behind a Worked-for row and expands it on click", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-commentary",
            kind: "message" as const,
            createdAt: "2026-04-13T12:00:00.000Z",
            message: {
              id: "message-commentary" as never,
              role: "assistant" as const,
              text: "Let me look around first.",
              turnId: "turn-1" as never,
              createdAt: "2026-04-13T12:00:00.000Z",
              completedAt: "2026-04-13T12:00:02.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-work",
            kind: "work" as const,
            createdAt: "2026-04-13T12:00:05.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:05.000Z",
              turnId: "turn-1" as never,
              label: "read files",
              detail: "Inspecting repository state",
              tone: "tool" as const,
            },
          },
          {
            id: "entry-final",
            kind: "message" as const,
            createdAt: "2026-04-13T12:00:20.000Z",
            message: {
              id: "message-final" as never,
              role: "assistant" as const,
              text: "All done.",
              turnId: "turn-1" as never,
              createdAt: "2026-04-13T12:00:20.000Z",
              completedAt: "2026-04-13T12:00:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    try {
      const foldButton = page.getByRole("button", { name: "Worked for 30s" });
      await expect.element(foldButton).toBeVisible();
      await expect.element(foldButton).toHaveAttribute("aria-expanded", "false");

      expect(document.body.textContent).toContain("All done.");
      expect(document.body.textContent).not.toContain("Let me look around first.");
      expect(document.body.textContent).not.toContain("Inspecting repository state");

      await foldButton.click();

      await expect.element(foldButton).toHaveAttribute("aria-expanded", "true");
      expect(document.body.textContent).toContain("Let me look around first.");
      expect(document.body.textContent).toContain("Inspecting repository state");

      await foldButton.click();

      await expect.element(foldButton).toHaveAttribute("aria-expanded", "false");
      expect(document.body.textContent).not.toContain("Inspecting repository state");
    } finally {
      await screen.unmount();
    }
  });
});
