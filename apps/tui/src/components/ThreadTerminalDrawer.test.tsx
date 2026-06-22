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
    const t = await testRender(
      <ThreadTerminalDrawer
        client={stubClient}
        info={info}
        cols={40}
        rows={4}
        focused={false}
        copyRef={copyRef}
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

  it("Given a tab is clicked, then onSelectTab fires with its id", async () => {
    const selected: string[] = [];
    const copyRef = React.createRef<(() => string) | null>() as React.MutableRefObject<
      (() => string) | null
    >;
    const t = await testRender(
      <ThreadTerminalDrawer
        client={stubClient}
        info={info}
        cols={40}
        rows={4}
        focused={false}
        copyRef={copyRef}
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
