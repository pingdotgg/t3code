import { describe, expect, it } from "@effect/vitest";

import {
  classifyUsageSourceExistence,
  negotiateUsageContractVersion,
  resolveOpenCodexHome,
  summarizeSourceReadFailures,
} from "./UsageService.ts";

describe("classifyUsageSourceExistence", () => {
  it("keeps I/O failures distinct from missing sources", () => {
    expect(classifyUsageSourceExistence(true)).toBe("present");
    expect(classifyUsageSourceExistence(false)).toBe("missing");
    expect(classifyUsageSourceExistence(null)).toBe("failed");
  });
});

describe("resolveOpenCodexHome", () => {
  it("prefers OPENCODEX_HOME", () => {
    expect(
      resolveOpenCodexHome({ OPENCODEX_HOME: "/custom/opencodex" }, "/home/user/.opencodex"),
    ).toBe("/custom/opencodex");
  });

  it("uses the standard OpenCodex home by default", () => {
    expect(resolveOpenCodexHome({}, "/home/user/.opencodex")).toBe("/home/user/.opencodex");
  });
});

describe("negotiateUsageContractVersion", () => {
  it("keeps v4 responses decodable for legacy clients", () => {
    expect(negotiateUsageContractVersion(undefined)).toBe(4);
    expect(negotiateUsageContractVersion(4)).toBe(4);
  });

  it("serves OpenCodex only to compatible clients", () => {
    expect(negotiateUsageContractVersion(5)).toBe(5);
    expect(negotiateUsageContractVersion(6)).toBe(5);
  });
});

describe("summarizeSourceReadFailures", () => {
  it("distinguishes healthy, partial, and failed stores", () => {
    expect(summarizeSourceReadFailures(1, 0)).toEqual({ status: "ok", message: null });
    expect(summarizeSourceReadFailures(2, 1)).toEqual({
      status: "partial",
      message: "1 usage file could not be read.",
    });
    expect(summarizeSourceReadFailures(1, 1)).toEqual({
      status: "failed",
      message: "1 usage file could not be read.",
    });
  });
});
