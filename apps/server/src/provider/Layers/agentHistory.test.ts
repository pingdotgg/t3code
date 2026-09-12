import { describe, it, expect } from "@effect/vitest";
import {
  agentHistoryEntry,
  boundedHistoryJson,
  boundedHistoryText,
  collectAgentHistory,
} from "./agentHistory.ts";

describe("agent history selection", () => {
  it("bounds text before advancing through later provider values", () => {
    function* values() {
      yield "x".repeat(9000);
      throw new Error("iterator advanced past the detail limit");
    }
    expect(boundedHistoryText(values())).toEqual({ text: "x".repeat(8000), truncated: true });
  });
  it("bounds nested JSON before serialization", () => {
    const value = {
      longValue: "x".repeat(2000),
      rows: Array.from({ length: 1000 }, (_, index) => index),
    };
    const result = boundedHistoryJson(value);
    expect(result.text.length).toBeLessThanOrEqual(8000);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("more items");
  });
  it("keeps file edits in recent tools", () => {
    const page = collectAgentHistory({ offset: 0, view: "recent-tools" });
    page.add(agentHistoryEntry("edit", "file-edit", "Edit X.jsx", "patch"));
    expect(page.result().entries.map((entry) => entry.id)).toEqual(["edit"]);
  });
  const entries = Array.from({ length: 130 }, (_, index) =>
    agentHistoryEntry(
      String(index),
      index % 2 ? "assistant" : "tool",
      `Entry ${index}`,
      "x".repeat(1000),
    ),
  );
  it("returns the newest five tools beyond the first page with compact details", () => {
    const page = collectAgentHistory({ offset: 0, view: "recent-tools" });
    for (const entry of entries) page.add(entry);
    expect(page.result().entries.map((entry) => entry.id)).toEqual([
      "120",
      "122",
      "124",
      "126",
      "128",
    ]);
    expect(
      page.result().entries.every((entry) => entry.detail.length === 240 && entry.truncated),
    ).toBe(true);
    expect(page.result().nextOffset).toBeNull();
  });
  it("opens on the latest page and supplies its position for previous navigation", () => {
    const page = collectAgentHistory({ offset: 0, view: "latest" });
    for (const entry of entries) page.add(entry);
    expect(page.result().startOffset).toBe(80);
    expect(page.result().entries.map((entry) => entry.id)).toEqual(
      entries.slice(-50).map((entry) => entry.id),
    );
    expect(page.result().nextOffset).toBeNull();
  });
  it("keeps forward pagination unchanged", () => {
    const page = collectAgentHistory({ offset: 50 });
    for (const entry of entries) if (page.add(entry)) break;
    expect(page.result().entries.map((entry) => entry.id)).toEqual(
      entries.slice(50, 100).map((entry) => entry.id),
    );
    expect(page.result().nextOffset).toBe(100);
  });
});
