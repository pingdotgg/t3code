import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupUsageWindows } from "./threadDetailsUsage.logic";

function window(
  id: string,
  label: string,
  kind: ServerProviderUsageWindow["kind"],
): ServerProviderUsageWindow {
  return { id, label, kind, usedPercent: 0 };
}

describe("groupUsageWindows", () => {
  it("groups pooled windows under their pool, shortest window first", () => {
    const groups = groupUsageWindows([
      window("3p-5h", "Claude & GPT (shared) · 5-hour", "session"),
      window("gemini-weekly", "Gemini · Weekly", "weekly"),
      window("3p-weekly", "Claude & GPT (shared) · Weekly", "weekly"),
      window("gemini-argon-weekly", "Gemini 4 Argon · Weekly", "weekly"),
      window("gemini-5h", "Gemini · 5-hour", "session"),
    ]);
    expect(
      groups.map((group) => [
        group.title,
        group.rows.map((row) => `${row.label}:${row.window.id}`),
      ]),
    ).toEqual([
      ["Claude & GPT (shared)", ["5-hour:3p-5h", "Weekly:3p-weekly"]],
      ["Gemini", ["5-hour:gemini-5h", "Weekly:gemini-weekly"]],
      ["Gemini 4 Argon", ["Weekly:gemini-argon-weekly"]],
    ]);
  });

  it("leaves plain and single-pool windows ungrouped with full labels", () => {
    expect(
      groupUsageWindows([window("s", "5-hour", "session"), window("w", "Weekly", "weekly")]),
    ).toEqual([{ title: null, rows: expect.any(Array) }]);
    const [only] = groupUsageWindows([window("g", "Gemini · Weekly", "weekly")]);
    expect(only?.title).toBeNull();
    expect(only?.rows[0]?.label).toBe("Gemini · Weekly");
  });
});
