import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isRemoteEnvironmentId } from "./environmentPresence";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");

describe("isRemoteEnvironmentId", () => {
  it("treats the primary environment as local and everything else as remote", () => {
    const scope = { primaryEnvironmentId, ownsLocalEnvironment: true };

    expect(isRemoteEnvironmentId(primaryEnvironmentId, scope)).toBe(false);
    expect(isRemoteEnvironmentId(remoteEnvironmentId, scope)).toBe(true);
  });

  it("treats every environment as remote when the app owns no local backend", () => {
    const scope = { primaryEnvironmentId: null, ownsLocalEnvironment: false };

    expect(isRemoteEnvironmentId(remoteEnvironmentId, scope)).toBe(true);
    expect(isRemoteEnvironmentId(primaryEnvironmentId, scope)).toBe(true);
  });

  it("treats nothing as remote while a managed app's primary is still registering", () => {
    const scope = { primaryEnvironmentId: null, ownsLocalEnvironment: true };

    expect(isRemoteEnvironmentId(remoteEnvironmentId, scope)).toBe(false);
  });
});
