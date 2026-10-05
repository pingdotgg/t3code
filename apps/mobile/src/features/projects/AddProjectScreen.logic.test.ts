import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAddProjectCwd, resolveAddProjectEnvironment } from "./AddProjectScreen.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function environment(environmentId: EnvironmentId, connectionState: EnvironmentConnectionPhase) {
  return { environmentId, connectionState };
}

describe("resolveAddProjectEnvironment", () => {
  it("does not redirect an explicit unavailable environment to another environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      ),
    ).toBeNull();
  });

  it("resolves an explicit connected environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "connected"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      )?.environmentId,
    ).toBe(ENVIRONMENT_A);
  });

  it("defaults to the first connected environment when no environment is requested", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        null,
      )?.environmentId,
    ).toBe(ENVIRONMENT_B);
  });
});

describe("resolveAddProjectCwd", () => {
  const selectedProject = { environmentId: ENVIRONMENT_A, workspaceRoot: "/work/current" };

  it("uses the selected project's workspace in the destination environment", () => {
    expect(resolveAddProjectCwd(ENVIRONMENT_A, selectedProject)).toBe("/work/current");
  });

  it("does not use another environment's workspace for relative paths", () => {
    expect(resolveAddProjectCwd(ENVIRONMENT_B, selectedProject)).toBeNull();
  });

  it("has no project context when either selection is missing", () => {
    expect(resolveAddProjectCwd(null, selectedProject)).toBeNull();
    expect(resolveAddProjectCwd(ENVIRONMENT_A, null)).toBeNull();
  });
});
