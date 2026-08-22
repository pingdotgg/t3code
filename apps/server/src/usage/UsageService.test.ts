import { describe, expect, it } from "@effect/vitest";

import {
  negotiateUsageContractVersion,
  resolveMcodeDataDir,
  summarizeSourceReadFailures,
} from "./UsageService.ts";

describe("resolveMcodeDataDir", () => {
  it("prefers the current MCode override and accepts the legacy name", () => {
    expect(resolveMcodeDataDir({ MINIMAX_DATA_DIR: "/custom/mcode" }, "/home/user/.minimax")).toBe(
      "/custom/mcode",
    );
    expect(resolveMcodeDataDir({ MAVIS_DATA_DIR: "/legacy/mavis" }, "/home/user/.minimax")).toBe(
      "/legacy/mavis",
    );
  });

  it("uses the shared TUI and desktop directory by default", () => {
    expect(resolveMcodeDataDir({}, "/home/user/.minimax")).toBe("/home/user/.minimax");
  });
});

describe("negotiateUsageContractVersion", () => {
  it("keeps v4 responses decodable for legacy clients", () => {
    expect(negotiateUsageContractVersion(undefined)).toBe(4);
    expect(negotiateUsageContractVersion(4)).toBe(4);
  });

  it("serves MCode only to compatible clients", () => {
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
