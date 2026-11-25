import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadDetailScreenProps } from "./ThreadDetailScreen";
import { ThreadScreenBinding, ThreadScreenHost } from "./ThreadScreenHost";

const screen = vi.hoisted(() => ({
  renders: 0,
  props: null as null | Record<string, unknown>,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ThreadDetailScreen", () => ({
  ThreadDetailScreen: (props: Record<string, unknown>) => {
    screen.renders += 1;
    screen.props = props;
    return null;
  },
}));

function Controller(props: {
  readonly title: string;
  readonly feed: ReadonlyArray<string>;
  readonly onSendMessage: () => string;
}) {
  return (
    <ThreadScreenBinding
      header={<h1>{props.title}</h1>}
      {...({
        selectedThreadFeed: props.feed,
        onSendMessage: props.onSendMessage,
      } as unknown as ThreadDetailScreenProps)}
    />
  );
}

describe("ThreadScreenHost", () => {
  it("re-renders the thread screen only when its data changes", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const render = (title: string, feed: ReadonlyArray<string>, reply: string) =>
      act(() =>
        root.render(
          <ThreadScreenHost>
            <Controller title={title} feed={feed} onSendMessage={() => reply} />
          </ThreadScreenHost>,
        ),
      );

    render("First", ["a", "b"], "first");
    expect(screen.renders).toBe(1);
    const firstFeed = screen.props?.selectedThreadFeed;

    // A new handler and an equal feed array keep the screen as it is.
    render("First", ["a", "b"], "second");
    expect(screen.renders).toBe(1);
    const onSendMessage = screen.props?.onSendMessage as () => string;
    expect(onSendMessage()).toBe("second");

    // A header-only change updates the header without the screen.
    render("Renamed", ["a", "b"], "second");
    expect(screen.renders).toBe(1);
    expect(container.textContent).toBe("Renamed");

    render("Renamed", ["a", "b", "c"], "second");
    expect(screen.renders).toBe(2);
    expect(screen.props?.selectedThreadFeed).not.toBe(firstFeed);
    expect(screen.props?.selectedThreadFeed).toEqual(["a", "b", "c"]);
  });
});
