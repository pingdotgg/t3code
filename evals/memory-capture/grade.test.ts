import { describe, expect, it } from "vite-plus/test";
import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

describe("memory capture grading", () => {
  it("rejects noisy memories and checks the reason, scope and evidence of useful ones", () => {
    const fixture = cases.find((entry) => entry.id === "reason-and-scope")!;
    const candidate = {
      kind: "decision" as const,
      content:
        "Acme invoice amounts use integer minor units to avoid floating-point rounding differences.",
      entities: ["billing"],
      citations: ["M1"],
    };
    expect(grade(fixture, { candidates: [candidate] })).toEqual([]);
    expect(grade(fixture, { candidates: [] })).toContain("Expected 1 memories, got 0");
    expect(
      grade(fixture, { candidates: [{ ...candidate, content: "Invoices use integers." }] }),
    ).toContain("Missing: rounding|floating.point");
    expect(
      grade(fixture, {
        candidates: [{ ...candidate, content: `${candidate.content} Do not migrate storage.` }],
      }),
    ).toContain("Unwanted: do not migrate|leave storage|this patch");
    expect(grade(fixture, { candidates: [{ ...candidate, citations: ["M9"] }] })).toContain(
      "Missing or invented citation",
    );
    expect(grade(fixture, { candidates: [{ ...candidate, citations: ["M2"] }] })).toContain(
      "Missing supporting citation M1",
    );
    const control = cases.find((entry) => entry.id === "empty-control")!;
    expect(grade(control, { candidates: [] })).toEqual([]);
    expect(grade(control, { candidates: [candidate] })).toEqual(["Expected 0 memories, got 1"]);
  });
});
