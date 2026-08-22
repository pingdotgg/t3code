import { describe, expect, it } from "@effect/vitest";

import { summarizeSourceReadFailures } from "./UsageService.ts";

describe("summarizeSourceReadFailures", () => {
  it("reports a healthy source when every file was readable", () => {
    expect(summarizeSourceReadFailures(2, 0)).toEqual({ status: "ok", message: null });
  });

  it("reports partial coverage when only some files failed", () => {
    expect(summarizeSourceReadFailures(2, 1)).toEqual({
      status: "partial",
      message: "1 usage file could not be read.",
    });
  });

  it("reports a failed source when every file failed", () => {
    expect(summarizeSourceReadFailures(2, 2)).toEqual({
      status: "failed",
      message: "2 usage files could not be read.",
    });
  });
});
