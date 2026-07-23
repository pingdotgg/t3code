import { describe, expect, it } from "@effect/vitest";

import { autoApprovedTools, describeToolCall, gateDecision } from "./t3-approvals.ts";

describe("t3-approvals: autoApprovedTools (default-deny allowlist)", () => {
  it("auto-approves only read-only tools by default", () => {
    const allowed = autoApprovedTools(undefined);
    for (const tool of ["read", "grep", "find", "ls", "glob"]) {
      expect(allowed.has(tool)).toBe(true);
    }
    for (const tool of ["bash", "write", "edit", "multi_edit", "apply_patch"]) {
      expect(allowed.has(tool)).toBe(false);
    }
  });

  it("adds edit tools only in auto-accept-edits mode; bash still gated", () => {
    const allowed = autoApprovedTools("auto-accept-edits");
    for (const tool of ["write", "edit", "multi_edit", "apply_patch"]) {
      expect(allowed.has(tool)).toBe(true);
    }
    expect(allowed.has("bash")).toBe(false);
    expect(allowed.has("read")).toBe(true);
  });

  it("treats unknown / custom / MCP tools as NOT auto-approved (default-deny)", () => {
    const allowed = autoApprovedTools("auto-accept-edits");
    for (const tool of ["foobar", "mcp__server__write", "rm", "move", ""]) {
      expect(allowed.has(tool)).toBe(false);
    }
  });
});

describe("t3-approvals: gateDecision (fail-closed)", () => {
  it("blocks when there is no UI to ask", () => {
    expect(gateDecision({ hasUI: false, confirmed: false })).toEqual({
      block: true,
      reason: "Denied in T3 Code",
    });
    expect(gateDecision({ hasUI: false, confirmed: true })).toEqual({
      block: true,
      reason: "Denied in T3 Code",
    });
  });

  it("blocks when the user declines", () => {
    expect(gateDecision({ hasUI: true, confirmed: false })).toEqual({
      block: true,
      reason: "Denied in T3 Code",
    });
  });

  it("allows when the user confirms", () => {
    expect(gateDecision({ hasUI: true, confirmed: true })).toBeUndefined();
  });
});

describe("t3-approvals: describeToolCall", () => {
  it("prefers a command string", () => {
    expect(describeToolCall("bash", { command: "  rm -rf /tmp/x  " })).toBe("rm -rf /tmp/x");
    expect(describeToolCall("bash", { cmd: "echo hi" })).toBe("echo hi");
  });

  it("falls back to a file path", () => {
    expect(describeToolCall("write", { file_path: "src/a.ts" })).toBe("src/a.ts");
    expect(describeToolCall("edit", { path: "src/b.ts" })).toBe("src/b.ts");
  });

  it("falls back to JSON, then the tool name", () => {
    expect(describeToolCall("custom", { foo: 1 })).toBe('{"foo":1}');
    expect(describeToolCall("custom", undefined)).toBe("custom");
  });

  it("truncates long detail to 500 chars", () => {
    const long = "x".repeat(1000);
    expect(describeToolCall("bash", { command: long }).length).toBe(500);
  });
});
