import { describe, expect, it } from "vite-plus/test";

import { resolveAgentSessionImportWindowMs } from "./agentSessions.ts";

describe("resolveAgentSessionImportWindowMs", () => {
  it("resolves 30d to 30 days in ms", () => {
    expect(resolveAgentSessionImportWindowMs("30d")).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("resolves 90d to 90 days in ms", () => {
    expect(resolveAgentSessionImportWindowMs("90d")).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("resolves 1y to 365 days in ms", () => {
    expect(resolveAgentSessionImportWindowMs("1y")).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("resolves all to null (no cutoff)", () => {
    expect(resolveAgentSessionImportWindowMs("all")).toBeNull();
  });
});
