import { describe, expect, it } from "vitest";

import { buildPiAcpSpawnInput } from "./PiAcpSupport.ts";

describe("buildPiAcpSpawnInput", () => {
  it("builds the default Pi ACP command", () => {
    expect(buildPiAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "pi-acp",
      args: [],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured Pi ACP adapter and Pi binary paths", () => {
    const env = { HOME: "/tmp/pi-home", PATH: "/usr/bin" };

    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "/Users/me/.local/bin/pi-acp",
          piBinaryPath: "/opt/homebrew/bin/pi",
        },
        "/tmp/project",
        env,
      ),
    ).toEqual({
      command: "/Users/me/.local/bin/pi-acp",
      args: [],
      cwd: "/tmp/project",
      env: {
        ...env,
        PATH: "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin",
        PI_ACP_PI_COMMAND: "/opt/homebrew/bin/pi",
      },
    });
  });

  it("adds configured absolute binary directories when PATH is missing", () => {
    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "/opt/homebrew/bin/pi-acp",
          piBinaryPath: "/opt/homebrew/bin/pi",
        },
        "/tmp/project",
        { HOME: "/tmp/pi-home" },
      ).env?.PATH,
    ).toBe("/opt/homebrew/bin");
  });

  it("preserves Windows Path casing and prepends cmd directories", () => {
    const env = {
      USERPROFILE: "C:\\Users\\me",
      Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
    };

    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\pi-acp.cmd",
          piBinaryPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd",
        },
        "C:\\work\\project",
        env,
      ),
    ).toEqual({
      command: "C:\\Users\\me\\AppData\\Roaming\\npm\\pi-acp.cmd",
      args: [],
      cwd: "C:\\work\\project",
      env: {
        ...env,
        Path: "C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Windows\\System32;C:\\Program Files\\nodejs",
        PI_ACP_PI_COMMAND: "C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd",
      },
    });
  });

  it("preserves Windows root executable directories", () => {
    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "C:\\pi-acp.cmd",
          piBinaryPath: "C:\\pi.cmd",
        },
        "C:\\work\\project",
        {},
      ).env?.PATH,
    ).toBe("C:\\");
  });

  it("does not add an empty PATH for relative commands without an existing path", () => {
    expect(
      buildPiAcpSpawnInput(
        {
          binaryPath: "pi-acp",
          piBinaryPath: "pi",
        },
        "/tmp/project",
        {},
      ).env,
    ).toEqual({
      PI_ACP_PI_COMMAND: "pi",
    });
  });
});
