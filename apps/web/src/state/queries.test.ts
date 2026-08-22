import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { areProjectPathSearchTargetsEqual, shouldSearchProjectPath } from "./queries";

describe("areProjectPathSearchTargetsEqual", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-a"),
    cwd: "/project-a",
    query: "index",
  };

  it("requires the environment, workspace, query, entry kind, and image filter to match", () => {
    expect(areProjectPathSearchTargetsEqual(target, target)).toBe(true);
    expect(
      areProjectPathSearchTargetsEqual(target, {
        ...target,
        environmentId: EnvironmentId.make("environment-b"),
      }),
    ).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, cwd: "/project-b" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, query: "readme" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, kind: "file" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, imageOnly: true })).toBe(false);
  });
});

describe("shouldSearchProjectPath", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-a"),
    cwd: "/project-a",
    query: "",
  };

  it("allows the composer to search recent project files for an empty @ query", () => {
    expect(shouldSearchProjectPath(target)).toBe(false);
    expect(shouldSearchProjectPath(target, true)).toBe(true);
  });
});
