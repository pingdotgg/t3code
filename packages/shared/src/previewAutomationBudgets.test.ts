import { describe, expect, it } from "vitest";

import {
  applySnapshotBudgets,
  candidateLocatorsFromElements,
  enforceFinalSnapshotTextBudget,
  filterConsoleEntries,
  filterNetworkEntries,
  resolveSnapshotBudgets,
} from "./previewAutomationBudgets.ts";

describe("previewAutomationBudgets", () => {
  it("defaults budgets to context-safe sizes", () => {
    const budgets = resolveSnapshotBudgets({});
    expect(budgets.includeAccessibilityTree).toBe(false);
    expect(budgets.consoleMode).toBe("important");
    expect(budgets.networkMode).toBe("failed");
    expect(budgets.maxVisibleText).toBe(8_000);
    expect(budgets.maxInteractiveElements).toBe(80);
  });

  it("filters console to important levels including CDP warning", () => {
    const entries = [
      { level: "log", text: "a", timestamp: "t1" },
      { level: "warn", text: "b", timestamp: "t2" },
      { level: "warning", text: "c", timestamp: "t3" },
      { level: "error", text: "d", timestamp: "t4" },
    ];
    expect(
      filterConsoleEntries(entries, {
        includeConsole: true,
        consoleMode: "important",
        maxConsoleEntries: 10,
      }).map((e) => e.level),
    ).toEqual(["warn", "warning", "error"]);
  });

  it("filters network to failed and 4xx+", () => {
    const entries = [
      { url: "/ok", method: "GET", status: 200, failed: false, timestamp: "t1" },
      { url: "/nope", method: "GET", status: 404, failed: false, timestamp: "t2" },
      { url: "/boom", method: "POST", status: null, failed: true, timestamp: "t3" },
    ];
    expect(
      filterNetworkEntries(entries, {
        includeNetwork: true,
        networkMode: "failed",
        maxNetworkEntries: 10,
      }).map((e) => e.url),
    ).toEqual(["/nope", "/boom"]);
  });

  it("builds locator candidates", () => {
    expect(
      candidateLocatorsFromElements([
        { role: "button", name: "Send", selector: "button.submit", tag: "button" },
        { role: null, name: "", selector: "#q", tag: "input" },
      ]),
    ).toEqual(['role=button[name="Send"]', 'text="Send"', "button.submit", "#q"]);
  });

  it("applies snapshot budgets and diagnostics summary", () => {
    const snapshot = applySnapshotBudgets(
      {
        url: "https://example.com",
        title: "Example",
        loading: false,
        visibleText: "x".repeat(100),
        interactiveElements: Array.from({ length: 5 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `B${i}`,
          selector: `#b${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
        accessibilityTree: { huge: true },
        consoleEntries: [
          { level: "log", text: "noise", timestamp: "t0" },
          { level: "warning", text: "careful", timestamp: "t0b" },
          { level: "error", text: "boom", timestamp: "t1" },
        ],
        networkEntries: [
          { url: "/ok", method: "GET", status: 200, failed: false, timestamp: "t0" },
          { url: "/bad", method: "GET", status: 500, failed: false, timestamp: "t1" },
        ],
        actionTimeline: [],
        screenshot: {
          mimeType: "image/png",
          data: "aa",
          width: 10,
          height: 10,
        },
      },
      resolveSnapshotBudgets({
        maxVisibleText: 10,
        maxInteractiveElements: 2,
      }),
    );

    expect(snapshot.visibleText.length).toBe(10);
    expect(snapshot.interactiveElements).toHaveLength(2);
    expect(snapshot.accessibilityTree).toBeNull();
    expect(snapshot.consoleEntries.map((e) => e.level)).toEqual(["warning", "error"]);
    expect(snapshot.networkEntries.map((e) => e.url)).toEqual(["/bad"]);
    expect(snapshot.diagnosticsSummary).toContain("console: 1 error(s), 1 warn(s)");
    expect(snapshot.diagnosticsSummary).toContain("latestError: boom");
  });

  it("returns small metadata unchanged by the final text budget", () => {
    const metadata = { url: "https://example.com", visibleText: "hello" };
    expect(enforceFinalSnapshotTextBudget(metadata, 60_000)).toBe(metadata);
  });

  it("enforces the final text budget while preserving identity fields", () => {
    const metadata = {
      tabId: "tab-1",
      url: "https://example.com",
      title: "Example",
      visibleText: "x".repeat(10_000),
      interactiveElements: [],
      accessibilityTree: { huge: "y".repeat(10_000) },
      consoleEntries: Array.from({ length: 20 }, (_, i) => ({
        level: "error",
        text: `boom ${i} ${"z".repeat(200)}`,
        timestamp: "t",
      })),
      networkEntries: Array.from({ length: 20 }, (_, i) => ({
        url: `/bad-${i}?${"q".repeat(200)}`,
        method: "GET",
        status: 500,
        failed: false,
        timestamp: "t",
      })),
      actionTimeline: Array.from({ length: 20 }, (_, i) => ({ id: `${i}` })),
      screenshot: { mimeType: "image/png", width: 10, height: 10 },
      screenshotPath: "/tmp/t3code-browser-evidence/shot.png",
      diagnosticsSummary: "s".repeat(5_000),
    };
    const trimmed = enforceFinalSnapshotTextBudget(metadata, 4_000);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(4_000);
    expect(trimmed.tabId).toBe("tab-1");
    expect(trimmed.url).toBe("https://example.com");
    expect(trimmed.title).toBe("Example");
    expect(trimmed.screenshotPath).toBe("/tmp/t3code-browser-evidence/shot.png");
    expect(trimmed.screenshot).toEqual({ mimeType: "image/png", width: 10, height: 10 });
    expect(trimmed.accessibilityTree).toBeNull();
  });

  it("bounds page-controlled strings that other budgets leave untouched", () => {
    const metadata = {
      tabId: "tab-1",
      url: `https://example.com/${"p".repeat(10_000)}`,
      title: "t".repeat(10_000),
      visibleText: "",
      interactiveElements: Array.from({ length: 10 }, (_, i) => ({
        tag: "button",
        role: "button",
        name: `B${i}${"n".repeat(2_000)}`,
        selector: `#b${i}${"s".repeat(2_000)}`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      })),
      accessibilityTree: null,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      screenshot: { mimeType: "image/png", width: 10, height: 10 },
      diagnosticsSummary: "",
      error: {
        _tag: "PreviewScreenshotInvalid",
        operation: "snapshot",
        message: "m".repeat(10_000),
      },
    };
    const trimmed = enforceFinalSnapshotTextBudget(metadata, 4_000);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(4_000);
    expect(trimmed.tabId).toBe("tab-1");
    expect((trimmed.error as { _tag: string })._tag).toBe("PreviewScreenshotInvalid");
  });
});
