import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAddProjectEnvironment } from "./AddProjectScreen.logic";

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
