import { describe, expect, it } from "vite-plus/test";

import { findReusableProjectScriptTerminal } from "./projectScriptTerminal";

const base = {
  drawerTerminalIds: [],
  activeTerminalId: "",
  panelTerminalIds: new Set<string>(),
  runningTerminalIds: [],
};

describe("findReusableProjectScriptTerminal", () => {
  it("does not reuse an idle right-panel terminal", () => {
    expect(
      findReusableProjectScriptTerminal({ ...base, panelTerminalIds: new Set(["term-1"]) }),
    ).toBeNull();
  });

  it("never reuses a panel terminal left in stale drawer state", () => {
    expect(
      findReusableProjectScriptTerminal({
        ...base,
        drawerTerminalIds: ["term-1"],
        activeTerminalId: "term-1",
        panelTerminalIds: new Set(["term-1"]),
      }),
    ).toBeNull();
  });

  it("reuses the active idle drawer terminal", () => {
    expect(
      findReusableProjectScriptTerminal({
        ...base,
        drawerTerminalIds: ["term-1", "term-2"],
        activeTerminalId: "term-2",
      }),
    ).toBe("term-2");
  });

  it("reuses another idle drawer terminal when the active one is busy", () => {
    expect(
      findReusableProjectScriptTerminal({
        ...base,
        drawerTerminalIds: ["term-1", "term-2"],
        activeTerminalId: "term-1",
        runningTerminalIds: ["term-1"],
      }),
    ).toBe("term-2");
  });

  it("finds nothing when every drawer terminal is busy", () => {
    expect(
      findReusableProjectScriptTerminal({
        ...base,
        drawerTerminalIds: ["term-1"],
        activeTerminalId: "term-1",
        runningTerminalIds: ["term-1"],
      }),
    ).toBeNull();
  });
});
