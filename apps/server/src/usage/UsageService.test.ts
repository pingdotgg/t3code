import { describe, expect, it } from "@effect/vitest";

import {
  negotiateUsageContractVersion,
  resolveKimiCodeHome,
  summarizeSourceReadFailures,
} from "./UsageService.ts";

describe("resolveKimiCodeHome", () => {
  it("prefers KIMI_CODE_HOME", () => {
    expect(resolveKimiCodeHome({ KIMI_CODE_HOME: "/custom/kimi" }, "/home/user/.kimi-code")).toBe(
      "/custom/kimi",
    );
  });

  it("uses the standard TUI home by default", () => {
    expect(resolveKimiCodeHome({}, "/home/user/.kimi-code")).toBe("/home/user/.kimi-code");
  });
});

describe("negotiateUsageContractVersion", () => {
  it("keeps v4 responses decodable for legacy clients", () => {
    expect(negotiateUsageContractVersion(undefined)).toBe(4);
    expect(negotiateUsageContractVersion(4)).toBe(4);
  });

  it("serves Kimi Code only to compatible clients", () => {
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
