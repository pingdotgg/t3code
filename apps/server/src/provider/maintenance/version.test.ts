import { expect, it } from "@effect/vitest";

import { compareMaintenanceVersions, normalizeMaintenanceVersion } from "./version.ts";

it("normalizes only valid full semantic versions", () => {
  expect(normalizeMaintenanceVersion("v1.2.3+build.01")).toBe("1.2.3+build.01");
  expect(normalizeMaintenanceVersion("1.0.0+foo-01")).toBe("1.0.0+foo-01");
  expect(normalizeMaintenanceVersion("1.0.0-01")).toBeNull();
});

it("compares abbreviated versions and ignores build metadata", () => {
  expect(compareMaintenanceVersions("1.2", "1.2.0")).toBe(0);
  expect(compareMaintenanceVersions("1.0.0+abc", "1.0.0+xyz")).toBe(0);
});

it("follows prerelease precedence without losing numeric precision", () => {
  expect(compareMaintenanceVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
  expect(compareMaintenanceVersions("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBe(-1);
  expect(compareMaintenanceVersions("1.0.0-01", "1.0.0-1")).toBeNull();
});
