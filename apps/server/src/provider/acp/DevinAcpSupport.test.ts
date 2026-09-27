import { describe, expect, it } from "@effect/vitest";

import { buildDevinAcpSpawnInput } from "./DevinAcpSupport.ts";

describe("buildDevinAcpSpawnInput", () => {
  it("starts the Devin CLI in ACP mode with the selected workspace", () => {
    expect(buildDevinAcpSpawnInput({ binaryPath: "/usr/local/bin/devin" }, "/tmp/project")).toEqual(
      {
        command: "/usr/local/bin/devin",
        args: ["acp"],
        cwd: "/tmp/project",
      },
    );
  });

  it("passes the configured provider environment to Devin", () => {
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "devin" }, "/tmp/project", { DEVIN_API_KEY: "x" }),
    ).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { DEVIN_API_KEY: "x" },
    });
  });
});
