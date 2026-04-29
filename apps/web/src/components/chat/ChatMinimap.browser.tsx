import "../../index.css";

import { type MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ChatMinimap } from "./ChatMinimap";
import { type MinimapUserMessageEntry } from "./ChatMinimap.logic";

interface MockListState {
  scroll: number;
  scrollLength: number;
  positionByKey: (key: string) => number | undefined;
  positionAtIndex: (index: number) => number | undefined;
  listen: (type: string, cb: (value: number) => void) => () => void;
}

function buildMockListRef({
  positionsByKey = {},
  positionsByIndex = {},
  initialScroll = 0,
}: {
  positionsByKey?: Record<string, number>;
  positionsByIndex?: Record<number, number>;
  initialScroll?: number;
} = {}): {
  listRef: React.RefObject<LegendListRef | null>;
  state: MockListState;
  scrollToIndex: ReturnType<typeof vi.fn>;
  setScroll: (next: number) => void;
} {
  const state: MockListState = {
    scroll: initialScroll,
    scrollLength: 500,
    positionByKey: (key) => positionsByKey[key],
    positionAtIndex: (index) => positionsByIndex[index],
    listen: () => () => {},
  };
  const scrollToIndex = vi.fn();
  const scrollableNode = document.createElement("div");
  const listRef = {
    current: {
      getState: () => state,
      scrollToIndex,
      getScrollableNode: () => scrollableNode,
    } as unknown as LegendListRef,
  } as React.RefObject<LegendListRef | null>;

  return {
    listRef,
    state,
    scrollToIndex,
    setScroll: (next: number) => {
      state.scroll = next;
      scrollableNode.dispatchEvent(new Event("scroll"));
    },
  };
}

function makeEntry(i: number, preview: string): MinimapUserMessageEntry {
  return {
    rowIndex: i * 2,
    rowKey: `entry-user-${i}`,
    messageId: `user-${i}` as MessageId,
    previewText: preview,
  };
}

describe("ChatMinimap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders nothing when there are no user message entries", async () => {
    const { listRef } = buildMockListRef();
    const screen = await render(
      <ChatMinimap listRef={listRef} entries={[]} threadKey="thread-1" />,
    );

    try {
      await expect
        .element(page.getByRole("navigation", { name: "User messages minimap" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("renders one dash per entry", async () => {
    const a = makeEntry(1, "Hello world");
    const b = makeEntry(2, "Second message");
    const { listRef } = buildMockListRef({
      positionsByKey: { [a.rowKey]: 100, [b.rowKey]: 900 },
    });

    const screen = await render(
      <ChatMinimap listRef={listRef} entries={[a, b]} threadKey="thread-1" />,
    );

    try {
      const dashes = screen.container.querySelectorAll('[data-testid="chat-minimap-dash"]');
      expect(dashes).toHaveLength(2);
      expect(Array.from(dashes).map((dash) => dash.tagName)).toEqual(["SPAN", "SPAN"]);
      expect(screen.container.querySelector('button[data-testid="chat-minimap-dash"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("activates the dash whose top has reached the viewport top on scroll", async () => {
    const a = makeEntry(1, "First");
    const b = makeEntry(2, "Second");
    const c = makeEntry(3, "Third");
    const { listRef, setScroll } = buildMockListRef({
      positionsByKey: { [a.rowKey]: 100, [b.rowKey]: 900, [c.rowKey]: 1700 },
      initialScroll: 0,
    });

    const screen = await render(
      <ChatMinimap listRef={listRef} entries={[a, b, c]} threadKey="thread-1" />,
    );

    try {
      await vi.waitFor(() => {
        const nodes = screen.container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="chat-minimap-dash"]',
        );
        expect(nodes[0]?.getAttribute("aria-current")).toBe("true");
      });

      setScroll(1000);
      await vi.waitFor(() => {
        const nodes = screen.container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="chat-minimap-dash"]',
        );
        expect(nodes[0]?.getAttribute("aria-current")).toBeNull();
        expect(nodes[1]?.getAttribute("aria-current")).toBe("true");
        expect(nodes[2]?.getAttribute("aria-current")).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("resets active highlight when threadKey changes", async () => {
    const a = makeEntry(1, "First");
    const b = makeEntry(2, "Second");
    const helper = buildMockListRef({
      positionsByKey: { [a.rowKey]: 100, [b.rowKey]: 900 },
      initialScroll: 1000,
    });

    const screen = await render(
      <ChatMinimap listRef={helper.listRef} entries={[a, b]} threadKey="thread-1" />,
    );

    try {
      await vi.waitFor(() => {
        const nodes = screen.container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="chat-minimap-dash"]',
        );
        expect(nodes[1]?.getAttribute("aria-current")).toBe("true");
      });

      helper.state.scroll = 0;
      await screen.rerender(
        <ChatMinimap listRef={helper.listRef} entries={[a, b]} threadKey="thread-2" />,
      );

      await vi.waitFor(() => {
        const nodes = screen.container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="chat-minimap-dash"]',
        );
        expect(nodes[1]?.getAttribute("aria-current")).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });

  const MOUSE_PARK_TESTID = "chat-minimap-mouse-park";
  const mousePark = (
    <div
      data-testid={MOUSE_PARK_TESTID}
      style={{
        position: "fixed",
        left: 16,
        bottom: 16,
        width: 120,
        height: 80,
      }}
    >
      park
    </div>
  );

  it("opens a menu with message previews on hover", async () => {
    const a = makeEntry(1, "First message text");
    const b = makeEntry(2, "Second message text");
    const c = makeEntry(3, "Third message text");
    const { listRef } = buildMockListRef({
      positionsByKey: { [a.rowKey]: 100, [b.rowKey]: 400, [c.rowKey]: 800 },
    });

    const screen = await render(
      <div>
        {mousePark}
        <ChatMinimap listRef={listRef} entries={[a, b, c]} threadKey="thread-1" />
      </div>,
    );

    try {
      await page.getByTestId(MOUSE_PARK_TESTID).hover();
      await vi.waitFor(() => {
        const nav = screen.container.querySelector('[data-testid="chat-minimap"]');
        expect(nav?.getAttribute("data-expanded")).toBeNull();
      });
      await page.getByTestId("chat-minimap-list").hover();

      await expect.element(page.getByTestId("chat-minimap-menu")).toBeVisible();

      const items = screen.container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-minimap-menu-item"]',
      );
      expect(items).toHaveLength(3);
      expect(items[0]?.textContent).toContain("First message text");
      expect(items[1]?.textContent).toContain("Second message text");
      expect(items[2]?.textContent).toContain("Third message text");
    } finally {
      await screen.unmount();
    }
  });

  it("clicking a menu item navigates and closes the menu", async () => {
    const a = makeEntry(1, "First");
    const b = makeEntry(2, "Second");
    const { listRef, scrollToIndex } = buildMockListRef({
      positionsByKey: { [a.rowKey]: 100, [b.rowKey]: 400 },
    });

    const screen = await render(
      <div>
        {mousePark}
        <ChatMinimap listRef={listRef} entries={[a, b]} threadKey="thread-1" />
      </div>,
    );

    try {
      await page.getByTestId(MOUSE_PARK_TESTID).hover();
      await vi.waitFor(() => {
        const nav = screen.container.querySelector('[data-testid="chat-minimap"]');
        expect(nav?.getAttribute("data-expanded")).toBeNull();
      });
      await page.getByTestId("chat-minimap-list").hover();
      await expect.element(page.getByTestId("chat-minimap-menu")).toBeVisible();

      const items = screen.container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-minimap-menu-item"]',
      );
      expect(items).toHaveLength(2);
      items[1]?.click();

      expect(scrollToIndex).toHaveBeenCalledTimes(1);
      expect(scrollToIndex).toHaveBeenCalledWith({
        index: b.rowIndex,
        animated: true,
        viewPosition: 0.08,
      });

      await vi.waitFor(() => {
        const nav = screen.container.querySelector('[data-testid="chat-minimap"]');
        expect(nav?.getAttribute("data-expanded")).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders an overflow indicator when entries exceed the dash cap", async () => {
    // 15 user prompts → strip caps at 10 dashes and surfaces a "+5" label
    // beneath. We only assert the label here; the dash count + sampling math
    // are covered by `selectVisibleMinimapEntries` unit tests.
    const entries = Array.from({ length: 15 }, (_, i) => makeEntry(i + 1, `Message ${i + 1}`));
    const positionsByKey = Object.fromEntries(
      entries.map((entry, i) => [entry.rowKey, 100 + i * 200]),
    );
    const { listRef } = buildMockListRef({ positionsByKey });

    const screen = await render(
      <ChatMinimap listRef={listRef} entries={entries} threadKey="thread-overflow" />,
    );

    try {
      await expect.element(page.getByTestId("chat-minimap-overflow")).toBeVisible();
      await expect.element(page.getByTestId("chat-minimap-overflow")).toHaveTextContent("+5");
      const dashes = screen.container.querySelectorAll('[data-testid="chat-minimap-dash"]');
      expect(dashes.length).toBeLessThanOrEqual(10);
    } finally {
      await screen.unmount();
    }
  });

  it("does not render the overflow indicator when entries fit under the cap", async () => {
    const a = makeEntry(1, "First");
    const b = makeEntry(2, "Second");
    const { listRef } = buildMockListRef({
      positionsByKey: { [a.rowKey]: 100, [b.rowKey]: 400 },
    });

    const screen = await render(
      <ChatMinimap listRef={listRef} entries={[a, b]} threadKey="thread-no-overflow" />,
    );

    try {
      await expect.element(page.getByTestId("chat-minimap-overflow")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("mouse-leave collapses the menu after a delay", async () => {
    const a = makeEntry(1, "First");
    const b = makeEntry(2, "Second");
    const { listRef } = buildMockListRef({
      positionsByKey: { [a.rowKey]: 100, [b.rowKey]: 400 },
    });

    const screen = await render(
      <div>
        {mousePark}
        <ChatMinimap listRef={listRef} entries={[a, b]} threadKey="thread-1" />
      </div>,
    );

    try {
      await page.getByTestId(MOUSE_PARK_TESTID).hover();
      await page.getByTestId("chat-minimap-list").hover();
      await expect.element(page.getByTestId("chat-minimap-menu")).toBeVisible();

      await page.getByTestId(MOUSE_PARK_TESTID).hover();

      await vi.waitFor(() => {
        const nav = screen.container.querySelector('[data-testid="chat-minimap"]');
        expect(nav?.getAttribute("data-expanded")).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });
});
