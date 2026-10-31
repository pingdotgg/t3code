import { describe, expect, it } from "vite-plus/test";

import { findReusableProjectScriptTerminal } from "./projectScriptTerminal";

describe("findReusableProjectScriptTerminal", () => {
  it.each([
    {
      name: "never reuses a right-panel terminal, even when stale in drawer state",
      drawerTerminalIds: ["term-1"],
      activeTerminalId: "term-1",
      panelTerminalIds: ["term-1"],
      runningTerminalIds: [],
      expected: null,
    },
    {
      name: "reuses the active idle drawer terminal",
      drawerTerminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
      panelTerminalIds: [],
      runningTerminalIds: [],
      expected: "term-2",
    },
    {
      name: "falls back to another idle drawer terminal when the active one is busy",
      drawerTerminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-1",
      panelTerminalIds: [],
      runningTerminalIds: ["term-1"],
      expected: "term-2",
    },
    {
      name: "finds nothing when every drawer terminal is busy",
      drawerTerminalIds: ["term-1"],
      activeTerminalId: "term-1",
      panelTerminalIds: [],
      runningTerminalIds: ["term-1"],
      expected: null,
    },
    {
      name: "reuses the active idle panel terminal when targeting the right panel",
      placement: "right-panel" as const,
      drawerTerminalIds: ["drawer"],
      activeTerminalId: "panel-2",
      panelTerminalIds: ["panel-1", "panel-2"],
      runningTerminalIds: [],
      expected: "panel-2",
    },
    {
      name: "falls back to an idle panel terminal when the active pane is busy",
      placement: "right-panel" as const,
      drawerTerminalIds: ["drawer"],
      activeTerminalId: "panel-1",
      panelTerminalIds: ["panel-1", "panel-2"],
      runningTerminalIds: ["panel-1"],
      expected: "panel-2",
    },
    {
      name: "does not reuse the drawer when every panel terminal is busy",
      placement: "right-panel" as const,
      drawerTerminalIds: ["drawer"],
      activeTerminalId: "drawer",
      panelTerminalIds: ["panel-1"],
      runningTerminalIds: ["panel-1"],
      expected: null,
    },
    {
      name: "requires a new panel terminal when none exists",
      placement: "right-panel" as const,
      drawerTerminalIds: ["drawer"],
      activeTerminalId: "drawer",
      panelTerminalIds: [],
      runningTerminalIds: [],
      expected: null,
    },
  ])("$name", ({ panelTerminalIds, expected, ...input }) => {
    expect(
      findReusableProjectScriptTerminal({ ...input, panelTerminalIds: new Set(panelTerminalIds) }),
    ).toBe(expected);
  });
});
