import { describe, expect, it } from "@effect/vitest";

import {
  chooseMcodeUsageStore,
  classifyUsageSourceExistence,
  negotiateUsageContractVersion,
  resolveMcodeDataDir,
  summarizeSourceReadFailures,
} from "./UsageService.ts";

describe("classifyUsageSourceExistence", () => {
  it("keeps I/O failures distinct from missing sources", () => {
    expect(classifyUsageSourceExistence(true)).toBe("present");
    expect(classifyUsageSourceExistence(false)).toBe("missing");
    expect(classifyUsageSourceExistence(null)).toBe("failed");
  });
});

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

describe("chooseMcodeUsageStore", () => {
  it("uses the alternate when the primary is only an empty compatibility stub", () => {
    expect(chooseMcodeUsageStore("primary.sqlite", "absent", "alternate.sqlite", "ready")).toBe(
      "alternate.sqlite",
    );
  });

  it("keeps the canonical primary when both stores have accounting", () => {
    expect(chooseMcodeUsageStore("primary.sqlite", "ready", "alternate.sqlite", "ready")).toBe(
      "primary.sqlite",
    );
  });

  it("keeps the primary fingerprint when its probe fails transiently", () => {
    expect(chooseMcodeUsageStore("primary.sqlite", "failed", "alternate.sqlite", "ready")).toBe(
      "primary.sqlite",
    );
  });

  it("keeps the alternate path when it is the only store but its probe fails", () => {
    expect(chooseMcodeUsageStore("primary.sqlite", "absent", "alternate.sqlite", "failed")).toBe(
      "alternate.sqlite",
    );
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
