import "../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { createInitialChatSplitLayout, replaceLeafTarget, splitLeaf } from "../chatSplitLayout";
import { useChatSplitLayoutStore } from "../chatSplitLayoutStore";

const { navigateSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateSpy,
}));

vi.mock("./ChatView", () => ({
  default: (props: {
    environmentId: string;
    threadId: string;
    isPaneFocused?: boolean;
    paneActions?: React.ReactNode;
    onDiffSearchChange?: (nextSearch: { diff?: "1" }) => void;
  }) => (
    <div data-testid="chat-view" data-pane-focused={props.isPaneFocused ? "true" : "false"}>
      <div data-testid="shortcut-owner">shortcut-owner</div>
      <div data-testid="terminal-shell">terminal-shell</div>
      <div>{`${props.environmentId}:${props.threadId}`}</div>
      <button type="button" onClick={() => props.onDiffSearchChange?.({ diff: "1" })}>
        Open diff in pane
      </button>
      {props.paneActions}
    </div>
  ),
}));

import { ChatSplitArea } from "./ChatSplitArea";

const initialState = useChatSplitLayoutStore.getState();

function createIdFactory() {
  let index = 0;
  return () => `node-${++index}`;
}

function serverTarget(environmentId: EnvironmentId, threadId: string) {
  return {
    kind: "server" as const,
    threadRef: {
      environmentId,
      threadId: ThreadId.make(threadId),
    },
  };
}

function clickLastButtonByLabel(label: string) {
  const buttons = document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`);
  buttons.item(buttons.length - 1)?.click();
}

function clickLastButtonByText(text: string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    button.textContent?.includes(text),
  );
  buttons.at(-1)?.click();
}

afterEach(() => {
  useChatSplitLayoutStore.setState(initialState, true);
  navigateSpy.mockClear();
});

describe("ChatSplitArea", () => {
  it("renders the next route target immediately when sidebar navigation changes threads", async () => {
    const environmentId = EnvironmentId.make("env-local");
    const targetA = serverTarget(environmentId, "thread-a");
    const targetB = serverTarget(environmentId, "thread-b");
    const screen = await render(<ChatSplitArea routeTarget={targetA} routeDiffSearch={{}} />);

    await expect.poll(() => document.body.textContent?.includes("thread-a") ?? false).toBe(true);

    await screen.rerender(<ChatSplitArea routeTarget={targetB} routeDiffSearch={{}} />);

    expect(document.body.textContent?.includes("thread-b")).toBe(true);
    expect(document.body.textContent?.includes("thread-a")).toBe(false);

    await screen.unmount();
  });

  it("fills a focused blank split pane when sidebar navigation changes threads", async () => {
    const environmentId = EnvironmentId.make("env-local");
    const targetA = serverTarget(environmentId, "thread-a");
    const targetB = serverTarget(environmentId, "thread-b");
    const screen = await render(<ChatSplitArea routeTarget={targetA} routeDiffSearch={{}} />);

    await expect.poll(() => document.querySelectorAll('[data-testid="chat-view"]').length).toBe(1);
    clickLastButtonByLabel("Split right");
    await expect
      .poll(
        () =>
          document.body.textContent?.includes(
            "Click or drag another chat you would like to split with",
          ) ?? false,
      )
      .toBe(true);

    await screen.rerender(<ChatSplitArea routeTarget={targetB} routeDiffSearch={{}} />);

    await expect.poll(() => document.querySelectorAll('[data-testid="chat-view"]').length).toBe(2);
    expect(document.body.textContent?.includes("thread-a")).toBe(true);
    expect(document.body.textContent?.includes("thread-b")).toBe(true);

    await screen.unmount();
  });

  it("focuses an inactive chat pane and navigates to that leaf target", async () => {
    const environmentId = EnvironmentId.make("env-local");
    const targetA = serverTarget(environmentId, "thread-a");
    const targetB = serverTarget(environmentId, "thread-b");
    const createId = createIdFactory();

    let layout = createInitialChatSplitLayout({ leafId: "root", target: targetA });
    layout = splitLeaf(layout, "root", "row", createId);
    layout = replaceLeafTarget(layout, layout.focusedLeafId, targetB);
    layout = { ...layout, focusedLeafId: "root" };

    const screen = await render(<ChatSplitArea routeTarget={targetA} routeDiffSearch={{}} />);
    await expect.poll(() => document.querySelectorAll('[data-testid="chat-view"]').length).toBe(1);

    useChatSplitLayoutStore.setState((state) => ({
      ...state,
      layout,
    }));

    await expect.poll(() => document.querySelectorAll('[data-testid="chat-view"]').length).toBe(2);
    navigateSpy.mockClear();

    const inactivePane = [...document.querySelectorAll('[data-testid="chat-view"]')].find(
      (element) => element.textContent?.includes("thread-b"),
    );
    const activePane = [...document.querySelectorAll('[data-testid="chat-view"]')].find((element) =>
      element.textContent?.includes("thread-a"),
    );
    expect(inactivePane).not.toBeNull();
    expect(inactivePane?.getAttribute("data-pane-focused")).toBe("false");
    expect(activePane?.getAttribute("data-pane-focused")).toBe("true");
    expect(activePane?.parentElement?.className).not.toContain("border-blue-500");
    inactivePane?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    await expect.poll(() => navigateSpy.mock.calls.length).toBe(1);
    const [navigation] = (navigateSpy.mock.calls.at(-1) as [any] | undefined) ?? [];
    expect(navigation).toMatchObject({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId: ThreadId.make("thread-b"),
      },
      replace: true,
    });

    await screen.unmount();
  });

  it("creates blank panes from header split buttons and navigates when diff state changes", async () => {
    const environmentId = EnvironmentId.make("env-local");
    const targetA = serverTarget(environmentId, "thread-a");
    const screen = await render(<ChatSplitArea routeTarget={targetA} routeDiffSearch={{}} />);

    await expect.poll(() => document.querySelectorAll('[data-testid="chat-view"]').length).toBe(1);

    clickLastButtonByLabel("Split right");
    await expect.poll(() => document.querySelectorAll('[data-testid="chat-view"]').length).toBe(1);
    await expect
      .poll(
        () =>
          document.body.textContent?.includes(
            "Click or drag another chat you would like to split with",
          ) ?? false,
      )
      .toBe(true);
    clickLastButtonByLabel("Split right");

    await expect
      .poll(() => document.body.textContent?.includes("Implement a production-quality") ?? false)
      .toBe(false);
    await expect.poll(() => document.querySelectorAll('[data-testid="chat-view"]').length).toBe(1);
    await expect
      .poll(() => document.querySelectorAll('[data-testid="chat-split-pane-preview"]').length)
      .toBe(0);

    navigateSpy.mockClear();
    const serverPane = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="chat-view"]'),
    ].find((element) => element.textContent?.includes("thread-a"));
    serverPane?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.poll(() => serverPane?.getAttribute("data-pane-focused")).toBe("true");
    clickLastButtonByText("Open diff in pane");

    await expect.poll(() => navigateSpy.mock.calls.length).toBe(1);
    const [navigation] = (navigateSpy.mock.calls.at(-1) as [any] | undefined) ?? [];
    expect(navigation).toMatchObject({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId: ThreadId.make("thread-a"),
      },
      replace: true,
    });
    expect(navigation.search({ existing: "value" })).toMatchObject({
      existing: "value",
      diff: "1",
    });

    await screen.unmount();
  });
});
