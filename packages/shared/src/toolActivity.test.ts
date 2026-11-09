import { describe, expect, it } from "vite-plus/test";

import {
  classifyToolActivity,
  computerUseActionLabel,
  dynamicToolSurface,
  mergeToolActivityData,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("classifies from kind and toolName without sniffing titles", () => {
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { toolName: "Grep" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    for (const toolName of ["github.read_file", "mongodb.find", "mcp__github__read_file"]) {
      expect(classifyToolActivity({ data: { toolName } })).toBe("other");
    }
    expect(classifyToolActivity({ title: "Find", data: {} })).toBe("other");
  });

  it("classifies Claude search tools ahead of their broad file-read request kind", () => {
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(classifyToolActivity({ requestKind: "file-read", data: { toolName } })).toBe("search");
    }
    expect(classifyToolActivity({ requestKind: "file-read", data: { toolName: "Read" } })).toBe(
      "read",
    );
  });

  it("keeps the first non-empty rawInput when a later update is empty", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { path: "src/a.ts", startLine: 4 } });
  });

  it("recognizes computer-use REPL calls before result metadata exists", () => {
    expect(dynamicToolSurface("cua_repl.js", {})).toBe("computer");
    for (const name of ["node_repl.js", "js"]) {
      expect(dynamicToolSurface(name, { code: "await sky.get_app_state(app);" })).toBe("computer");
      expect(dynamicToolSurface(name, { code: "const sky = await import('@oai/sky');" })).toBe(
        "computer",
      );
      expect(dynamicToolSurface(name, { code: "await fs.readFile(path);" })).toBeUndefined();
    }
    expect(dynamicToolSurface("github.js", { code: "await sky.click(app);" })).toBeUndefined();
  });

  it("recognizes screen-control tools from any provider or MCP server", () => {
    for (const toolName of [
      "computer",
      "computer_use",
      "computer_screenshot",
      "ComputerScroll",
      "screenshot",
      "mcp__computer-use__computer_click",
      "mcp__computer-use__left_click",
      "cua_click",
    ]) {
      expect(dynamicToolSurface(toolName, {})).toBe("computer");
    }
    for (const toolName of ["read_file", "computing_search", "bash", "github.read_file"]) {
      expect(dynamicToolSurface(toolName, {})).toBeUndefined();
    }
  });

  it("labels what a screen-control call did", () => {
    expect(computerUseActionLabel("computer_click", { x: 412, y: 220 })).toBe("Clicked 412, 220");
    expect(computerUseActionLabel("computer_click", { coordinate: [10, 20] })).toBe(
      "Clicked 10, 20",
    );
    expect(computerUseActionLabel("computer_type", { text: "hello world" })).toBe(
      "Typed “hello world”",
    );
    expect(computerUseActionLabel("computer_key", { key: "cmd+s" })).toBe("Pressed cmd+s");
    expect(computerUseActionLabel("computer_scroll", { direction: "down" })).toBe("Scrolled");
    expect(computerUseActionLabel("computer_screenshot", {})).toBe("Viewed the screen");
    expect(computerUseActionLabel("read_file", {})).toBeUndefined();
  });
});
