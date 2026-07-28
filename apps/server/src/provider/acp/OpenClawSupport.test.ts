import { describe, expect, it } from "vite-plus/test";

import { buildOpenClawSpawnInput } from "./OpenClawSupport.ts";

describe("OpenClawSupport", () => {
  it("uses config and environment by default", () => {
    expect(
      buildOpenClawSpawnInput(
        {
          binaryPath: "openclaw",
          url: "",
          tokenFile: "",
          passwordFile: "",
          session: "",
          resetSession: false,
        },
        "/workspace/project",
        { OPENCLAW_CONFIG_DIR: "/config/openclaw" },
      ),
    ).toEqual({
      command: "openclaw",
      args: ["acp"],
      cwd: "/workspace/project",
      env: { OPENCLAW_CONFIG_DIR: "/config/openclaw" },
    });
  });

  it("passes only documented non-secret and credential-file overrides", () => {
    const spawn = buildOpenClawSpawnInput(
      {
        binaryPath: "/opt/openclaw/bin/openclaw",
        url: "wss://gateway.example.com",
        tokenFile: "/run/secrets/openclaw-token",
        passwordFile: "/run/secrets/openclaw-password",
        session: "agent:main:main",
        resetSession: true,
      },
      "/workspace/project",
    );

    expect(spawn.args).toEqual([
      "acp",
      "--url",
      "wss://gateway.example.com",
      "--token-file",
      "/run/secrets/openclaw-token",
      "--password-file",
      "/run/secrets/openclaw-password",
      "--session",
      "agent:main:main",
      "--reset-session",
    ]);
    expect(spawn.args).not.toContain("--token");
    expect(spawn.args).not.toContain("--password");
  });
});
