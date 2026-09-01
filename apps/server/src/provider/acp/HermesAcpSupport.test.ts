import { describe, expect, it } from "@effect/vitest";

import { buildHermesAcpSpawnInput, HERMES_AUTH_METHOD_ID } from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("spawns the configured binary with the acp subcommand", () => {
    const spawn = buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes" }, "/tmp/project", {
      PATH: "/usr/bin",
    });

    expect(spawn).toEqual({
      command: "/opt/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        PATH: "/usr/bin",
      },
    });
  });

  it("falls back to the default binary name", () => {
    const spawn = buildHermesAcpSpawnInput({ binaryPath: "" }, "/tmp/project");
    expect(spawn.command).toBe("hermes");
  });

  it("falls back when settings are absent", () => {
    const spawn = buildHermesAcpSpawnInput(null, "/tmp/project");
    expect(spawn.command).toBe("hermes");
  });

  it("omits env entirely when no environment is provided", () => {
    const spawn = buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes" }, "/tmp/project");
    expect(spawn).toEqual({
      command: "/opt/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("HERMES_AUTH_METHOD_ID", () => {
  it("targets the Hermes custom-credentials auth method", () => {
    expect(HERMES_AUTH_METHOD_ID).toBe("custom");
  });
});
