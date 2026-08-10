import { describe, expect, it } from "vite-plus/test";

import { expandBulkPrompts, parseBulkPlaceholders, splitBulkValues } from "./bulkPrompt";

describe("parseBulkPlaceholders", () => {
  it("returns distinct placeholders in first-appearance order", () => {
    expect(parseBulkPlaceholders("/rooom:ship {jirakey} onto {branch}")).toEqual([
      { name: "jirakey", occurrences: 1 },
      { name: "branch", occurrences: 1 },
    ]);
  });

  it("accepts double braces for prompts that also contain code", () => {
    expect(parseBulkPlaceholders("/rooom:ship {{jirakey}}")).toEqual([
      { name: "jirakey", occurrences: 1 },
    ]);
  });

  it("counts a repeated placeholder once", () => {
    expect(parseBulkPlaceholders("{key} then { key }")).toEqual([{ name: "key", occurrences: 2 }]);
  });

  it("leaves single braces alone once the prompt uses double braces", () => {
    expect(
      parseBulkPlaceholders('import { useState } from "react" — then /rooom:ship {{jirakey}}'),
    ).toEqual([{ name: "jirakey", occurrences: 1 }]);
  });

  it("ignores tokens that are not placeholder names", () => {
    expect(parseBulkPlaceholders('{ } {a b} {} {"key": 1}')).toEqual([]);
  });
});

describe("splitBulkValues", () => {
  it("splits on commas and newlines and drops blanks", () => {
    expect(splitBulkValues(" FE-1, FE-2 ,,\nFE-3\n\n")).toEqual(["FE-1", "FE-2", "FE-3"]);
  });

  it("keeps duplicates so a repeated value still starts its own thread", () => {
    expect(splitBulkValues("FE-1, FE-1")).toEqual(["FE-1", "FE-1"]);
  });
});

describe("expandBulkPrompts", () => {
  it("builds one row per value and replaces every occurrence", () => {
    const result = expandBulkPrompts({
      text: "/rooom:ship {jirakey} — see {jirakey}",
      valuesByPlaceholder: { jirakey: ["FE-1", "FE-2"] },
    });

    expect(result).toEqual({
      ok: true,
      rows: [
        {
          prompt: "/rooom:ship FE-1 — see FE-1",
          values: { jirakey: "FE-1" },
          label: "FE-1",
        },
        {
          prompt: "/rooom:ship FE-2 — see FE-2",
          values: { jirakey: "FE-2" },
          label: "FE-2",
        },
      ],
    });
  });

  it("refuses to expand while one placeholder still has no value", () => {
    const result = expandBulkPrompts({
      text: "{key} keeps {unknown}",
      valuesByPlaceholder: { key: ["FE-1"], unknown: [] },
    });

    // Reported as missing rather than silently blanked out in the prompt.
    expect(result).toEqual({ ok: false, reason: "missing-values", placeholder: "unknown" });
  });

  it("keeps single-braced code literal when the prompt uses double braces", () => {
    const result = expandBulkPrompts({
      text: "add { useState } for {{jirakey}}",
      valuesByPlaceholder: { jirakey: ["FE-1"] },
    });

    expect(result.ok && result.rows[0]?.prompt).toBe("add { useState } for FE-1");
  });

  it("broadcasts a single value across the rows of a longer list", () => {
    const result = expandBulkPrompts({
      text: "{{key}} on {{branch}}",
      valuesByPlaceholder: { key: ["FE-1", "FE-2"], branch: ["main"] },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.rows.map((row) => row.prompt)).toEqual([
      "FE-1 on main",
      "FE-2 on main",
    ]);
  });

  it("rejects lists that cannot be zipped", () => {
    expect(
      expandBulkPrompts({
        text: "{{key}} on {{branch}}",
        valuesByPlaceholder: { key: ["FE-1", "FE-2", "FE-3"], branch: ["main", "dev"] },
      }),
    ).toEqual({
      ok: false,
      reason: "length-mismatch",
      placeholder: "branch",
      expected: 3,
      actual: 2,
    });
  });

  it("reports the placeholder that has no values", () => {
    expect(
      expandBulkPrompts({
        text: "{{key}} on {{branch}}",
        valuesByPlaceholder: { key: ["FE-1"] },
      }),
    ).toEqual({ ok: false, reason: "missing-values", placeholder: "branch" });
  });

  it("refuses a prompt without placeholders", () => {
    expect(expandBulkPrompts({ text: "/rooom:ship FE-1", valuesByPlaceholder: {} })).toEqual({
      ok: false,
      reason: "no-placeholders",
    });
  });
});
