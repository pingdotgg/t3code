import { describe, expect, it } from "bun:test";
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
  it("Given terminal output is visible, when the server clears the session, then the stale buffer disappears", async () => {
    let onEvent: Parameters<TuiClient["subscribeTerminal"]>[1] = () => {
      throw new Error("terminal subscription not ready");
    };
    const eventClient = {
      subscribeTerminal: (
        _input: Parameters<TuiClient["subscribeTerminal"]>[0],
        next: Parameters<TuiClient["subscribeTerminal"]>[1],
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
        focused={false}
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

    onEvent?.({
      type: "output",
      threadId: "t1",
      terminalId: "term-1",
      data: "visible-before-clear",
    } as never);
    await Bun.sleep(25);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("visible-before-clear");

    onEvent?.({ type: "cleared", threadId: "t1", terminalId: "term-1" } as never);
    await Bun.sleep(25);
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("visible-before-clear");
    t.renderer.destroy();
  });
});
