import { describe, expect, it } from "@effect/vitest";

import { negotiateUsageContractVersion, summarizeSourceReadFailures } from "./UsageService.ts";

describe("negotiateUsageContractVersion", () => {
  it("keeps the v4 response shape for clients that do not advertise support", () => {
    expect(negotiateUsageContractVersion(undefined)).toBe(4);
    expect(negotiateUsageContractVersion(4)).toBe(4);
  });

  it("serves the current response shape to compatible clients", () => {
    expect(negotiateUsageContractVersion(5)).toBe(5);
    expect(negotiateUsageContractVersion(6)).toBe(5);
  });
});

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
