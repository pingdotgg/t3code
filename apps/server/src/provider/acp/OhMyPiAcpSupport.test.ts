import { describe, expect, it } from "@effect/vitest";

import {
  buildOhMyPiAcpSpawnInput,
  OH_MY_PI_AUTH_METHOD_ID,
} from "./OhMyPiAcpSupport.ts";

describe("OhMyPiAcpSupport", () => {
  it("launches the normal OMP ACP command from PATH", () => {
    expect(buildOhMyPiAcpSpawnInput({}, "/tmp/project")).toEqual({
      command: "omp",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("honors a configured OMP binary path and environment", () => {
    const env = { HOME: "/tmp/home" };
    expect(
      buildOhMyPiAcpSpawnInput({ binaryPath: "/opt/omp/bin/omp" }, "/tmp/project", env),
    ).toEqual({
      command: "/opt/omp/bin/omp",
      args: ["acp"],
      cwd: "/tmp/project",
      env,
    });
  });

  it("uses the auth method advertised by current OMP ACP", () => {
    expect(OH_MY_PI_AUTH_METHOD_ID).toBe("agent");
  });
});
