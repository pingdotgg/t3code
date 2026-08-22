import { afterEach, describe, expect, it, jest } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { TuiClient } from "../connection.ts";
import { ThreadTerminalDrawer, type TerminalInfo } from "./ThreadTerminalDrawer.tsx";

// A stub client whose terminal subscription never calls back, so the drawer just
// renders its chrome (tab bar + empty frame).
const stubClient = {
  subscribeTerminal: () => () => {},
  terminalWrite: () => Promise.resolve(),
  terminalResize: () => Promise.resolve(),
  terminalClose: () => Promise.resolve(),
} as unknown as TuiClient;

const info: TerminalInfo = {
  threadId: "t1" as never,
  terminalId: "term-1",
  title: "My thread",
  cwd: "/work",
  worktreePath: null,
};

describe("ThreadTerminalDrawer tab bar", () => {
  it("keeps the close control available for the final terminal", async () => {
    const closed: string[] = [];
    const copyRef = React.createRef<(() => string) | null>() as React.MutableRefObject<
      (() => string) | null
    >;
    const scrollRef = React.createRef<
      ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
    >() as React.MutableRefObject<
      ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
    >;
    const setup = await testRender(
      <ThreadTerminalDrawer
        client={stubClient}
        info={info}
        cols={40}
        rows={4}
        focused={false}
        copyRef={copyRef}
        scrollRef={scrollRef}
        tabIds={["term-1"]}
        activeTabId="term-1"
        onSelectTab={() => {}}
        onNewTab={() => {}}
        onCloseTab={(id) => closed.push(id)}
      />,
      { width: 50, height: 12 },
    );

    await setup.renderOnce();
    await setup.flush();
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("✕"));
    const column = row < 0 ? -1 : (lines[row]?.indexOf("✕") ?? -1);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(column).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(column, row);
    await setup.flush();
    expect(closed).toEqual(["term-1"]);
    setup.renderer.destroy();
  });

  it("Given multiple tabs, then it lists their numbers, a close mark, and '+ new'", async () => {
    const copyRef = React.createRef<(() => string) | null>() as React.MutableRefObject<
      (() => string) | null
    >;
    const scrollRef = React.createRef<
      ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
    >() as React.MutableRefObject<
      ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
    >;
    const t = await testRender(
      <ThreadTerminalDrawer
        client={stubClient}
        info={info}
        cols={40}
        rows={4}
        focused={false}
        copyRef={copyRef}
        scrollRef={scrollRef}
        tabIds={["term-1", "term-2"]}
        activeTabId="term-1"
        onSelectTab={() => {}}
        onNewTab={() => {}}
        onCloseTab={() => {}}
      />,
      { width: 50, height: 12 },
    );
    await t.renderOnce();
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Terminal · My thread");
    expect(frame).toContain("+ new");
    expect(frame).toContain("1");
    expect(frame).toContain("2");
    expect(frame).toContain("✕");
    t.renderer.destroy();
  });

  it("Given a tab switch, then both panes stay subscribed (kept alive, no replay)", async () => {
    let subscribes = 0;
    let unsubscribes = 0;
    const countingClient = {
      subscribeTerminal: () => {
        subscribes += 1;
        return () => {
          unsubscribes += 1;
        };
      },
      terminalWrite: () => Promise.resolve(),
      terminalResize: () => Promise.resolve(),
      terminalClose: () => Promise.resolve(),
    } as unknown as TuiClient;

    function Harness(): React.ReactNode {
      const [active, setActive] = React.useState("term-1");
      const copyRef = React.useRef<(() => string) | null>(null);
      const scrollRef = React.useRef<
        ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
      >(null);
      return (
        <ThreadTerminalDrawer
          client={countingClient}
          info={info}
          cols={40}
          rows={4}
          focused={false}
          copyRef={copyRef}
          scrollRef={scrollRef}
          tabIds={["term-1", "term-2"]}
          activeTabId={active}
          onSelectTab={setActive}
          onNewTab={() => {}}
          onCloseTab={() => {}}
        />
      );
    }

    const t = await testRender(<Harness />, { width: 50, height: 12 });
    await t.renderOnce();
    await t.flush();
    // Both tabs' panes mount and subscribe up front.
    expect(subscribes).toBe(2);

    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("+ new"));
    const col = (lines[row] ?? "").indexOf("2");
    await t.mockMouse.click(col, row);
    await t.flush();
    // Switching active did NOT tear down or recreate a subscription — kept alive.
    expect(subscribes).toBe(2);
    expect(unsubscribes).toBe(0);
    t.renderer.destroy();
  });

  it("Given a tab is clicked, then onSelectTab fires with its id", async () => {
    const selected: string[] = [];
    const copyRef = React.createRef<(() => string) | null>() as React.MutableRefObject<
      (() => string) | null
    >;
    const scrollRef = React.createRef<
      ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
    >() as React.MutableRefObject<
      ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
    >;
    const t = await testRender(
      <ThreadTerminalDrawer
        client={stubClient}
        info={info}
        cols={40}
        rows={4}
        focused={false}
        copyRef={copyRef}
        scrollRef={scrollRef}
        tabIds={["term-1", "term-2"]}
        activeTabId="term-1"
        onSelectTab={(id) => selected.push(id)}
        onNewTab={() => {}}
        onCloseTab={() => {}}
      />,
      { width: 50, height: 12 },
    );
    await t.renderOnce();
    await t.flush();
    const lines = t.captureCharFrame().split("\n");
    // The tab bar is the second row (header, then tabs); find the "2" tab.
    const row = lines.findIndex((line) => line.includes("+ new"));
    const col = (lines[row] ?? "").indexOf("2");
    await t.mockMouse.click(col, row);
    await t.flush();
    expect(selected).toEqual(["term-2"]);
    t.renderer.destroy();
  });
});

describe("ThreadTerminalDrawer session events", () => {
  type TerminalSubscriber = Parameters<TuiClient["subscribeTerminal"]>[1];
  type TerminalStreamEvent = Parameters<TerminalSubscriber>[0];

  afterEach(() => {
    jest.useRealTimers();
  });

  const renderTerminalEvent = async (
    t: Awaited<ReturnType<typeof testRender>>,
    onEvent: TerminalSubscriber,
    event: TerminalStreamEvent,
  ): Promise<void> => {
    await React.act(async () => {
      onEvent(event);
      jest.runAllTimers();
    });
    await t.renderOnce();
  };

  const renderTerminalSession = async (focused: boolean) => {
    let onEvent: TerminalSubscriber = () => {
      throw new Error("terminal subscription not ready");
    };
    const eventClient = {
      subscribeTerminal: (
        _input: Parameters<TuiClient["subscribeTerminal"]>[0],
        next: TerminalSubscriber,
      ) => {
        onEvent = next;
        return () => {};
      },
      terminalWrite: () => Promise.resolve(),
      terminalResize: () => Promise.resolve(),
      terminalClose: () => Promise.resolve(),
    } as unknown as TuiClient;
    const copyRef = React.createRef<(() => string) | null>() as React.MutableRefObject<
      (() => string) | null
    >;
    const scrollRef = React.createRef<
      ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
    >() as React.MutableRefObject<
      ((action: "line-up" | "line-down" | "page-up" | "page-down" | "bottom") => void) | null
    >;
    const t = await testRender(
      <ThreadTerminalDrawer
        client={eventClient}
        info={info}
        cols={40}
        rows={4}
        focused={focused}
        copyRef={copyRef}
        scrollRef={scrollRef}
        tabIds={["term-1"]}
        activeTabId="term-1"
        onSelectTab={() => {}}
        onNewTab={() => {}}
        onCloseTab={() => {}}
      />,
      { width: 50, height: 12 },
    );
    await t.renderOnce();
    await t.flush();
    jest.useFakeTimers();
    return {
      t,
      copyRef,
      scrollRef,
      emit: (event: TerminalStreamEvent) => renderTerminalEvent(t, onEvent, event),
    };
  };

  it("Given the shell cursor is on a blank cell, then the drawer renders a visible block", async () => {
    const { t, emit } = await renderTerminalSession(true);
    await emit({
      type: "output",
      threadId: "t1",
      terminalId: "term-1",
      data: "$ ",
    } as never);

    expect(t.captureCharFrame()).toContain("$ █");
    t.renderer.destroy();
  });

  it("Given the cursor moves over text, then that character retains a visible block background", async () => {
    const { t, emit } = await renderTerminalSession(true);

    // Write "abc", then move two cells left so xterm's cursor sits on "b".
    await emit({
      type: "output",
      threadId: "t1",
      terminalId: "term-1",
      data: "abc\x1b[2D",
    } as never);

    const terminalLine = t.captureSpans().lines.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("abc"),
    );
    const cursorSpan = terminalLine?.spans.find((span) => span.text === "b");
    expect(cursorSpan?.bg.intent).toBe("indexed");
    expect(cursorSpan?.bg.slot).toBe(6);
    t.renderer.destroy();
  });

  it("Given terminal output is visible, when the server clears the session, then the stale buffer disappears", async () => {
    const { t, emit } = await renderTerminalSession(false);
    await emit({
      type: "output",
      threadId: "t1",
      terminalId: "term-1",
      data: "visible-before-clear",
    } as never);
    expect(t.captureCharFrame()).toContain("visible-before-clear");

    await emit({
      type: "cleared",
      threadId: "t1",
      terminalId: "term-1",
    } as never);
    expect(t.captureCharFrame()).not.toContain("visible-before-clear");
    t.renderer.destroy();
  });

  it("keeps copied scrollback anchored while new output arrives", async () => {
    const { t, emit, copyRef, scrollRef } = await renderTerminalSession(false);
    await emit({
      type: "output",
      threadId: "t1",
      terminalId: "term-1",
      data: "L1\r\nL2\r\nL3\r\nL4\r\nL5\r\n",
    } as never);
    await React.act(async () => {
      scrollRef.current?.("line-up");
      await t.renderOnce();
    });
    const before = copyRef.current?.();
    expect(before).toContain("L3");

    await emit({
      type: "output",
      threadId: "t1",
      terminalId: "term-1",
      data: "L6\r\n",
    } as never);
    expect(copyRef.current?.()).toBe(before);
    t.renderer.destroy();
  });
});
