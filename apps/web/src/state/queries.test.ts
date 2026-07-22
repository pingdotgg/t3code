import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { areProjectPathSearchTargetsEqual } from "./queries";

describe("areProjectPathSearchTargetsEqual", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-a"),
    cwd: "/project-a",
    query: "index",
  };

  it("requires the environment, workspace, query, and entry kind to match", () => {
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
  });
});
