import { describe, expect, it } from "vite-plus/test";

import { type CheckResult, renderFindings, summarize } from "./engine-probe.ts";

const results: ReadonlyArray<CheckResult> = [
  {
    id: "A",
    subject: "Compaction override reaches the thread",
    verdict: "PASS",
    evidence: ["Bash saw 60", "threshold 600000 tokens"],
    ms: 10_840,
  },
  {
    id: "F",
    subject: "Absolute paths",
    verdict: "FAIL",
    evidence: ["listEntries: error a | b\nsecond line"],
    ms: 120,
  },
  { id: "J", subject: "Preview without a client", verdict: "PASS", evidence: [], ms: 61_250 },
];

describe("engine probe summary", () => {
  it("Given three fixed results, when summarized, then the markdown rows are exactly these", () => {
    expect(summarize(results)).toBe(
      [
        "| Check | Subject | Verdict | Evidence | Wall time |",
        "| --- | --- | --- | --- | --- |",
        "| A | Compaction override reaches the thread | PASS | Bash saw 60<br>threshold 600000 tokens | 10.8 s |",
        "| F | Absolute paths | FAIL | listEntries: error a \\| b second line | 0.1 s |",
        "| J | Preview without a client | PASS |  | 61.3 s |",
      ].join("\n"),
    );
  });

  it("Given a failed check, when the findings render, then its follow-up is listed and the passes are not", () => {
    const text = renderFindings(
      results,
      { A: "never", F: "Pass the folder as cwd." },
      {
        date: "2026-11-20T00:00:00.000Z",
        engineVersion: "0.1.10",
        claudeVersion: "2.1.309 (Claude Code)",
        model: "claude-haiku-5-5",
        totalMs: 72_210,
      },
    );
    expect(text).toContain(summarize(results));
    expect(text).toContain("- Check F. Pass the folder as cwd.");
    expect(text).not.toContain("never");
  });

  it("Given every check passed, when the findings render, then they say no later PR needs a workaround", () => {
    const passed = results.map((result) => ({ ...result, verdict: "PASS" as const }));
    const text = renderFindings(
      passed,
      {},
      {
        date: "2026-11-20T00:00:00.000Z",
        engineVersion: "0.1.10",
        claudeVersion: "2.1.309 (Claude Code)",
        model: "claude-haiku-5-5",
        totalMs: 1_000,
      },
    );
    expect(text).toContain("No check failed, so no later PR needs a workaround.");
  });
});
