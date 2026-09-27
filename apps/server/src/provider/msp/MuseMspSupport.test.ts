import { describe, expect, it } from "@effect/vitest";

import { buildMuseMspSpawnInput } from "./MuseMspSupport.ts";

describe("buildMuseMspSpawnInput", () => {
  it("starts the Muse CLI as an MSP session host with the selected workspace", () => {
    expect(buildMuseMspSpawnInput({ binaryPath: "/usr/local/bin/muse" }, "/tmp/project")).toEqual({
      command: "/usr/local/bin/muse",
      args: ["serve"],
      cwd: "/tmp/project",
    });
  });

  it("passes the configured provider environment to Muse", () => {
    expect(
      buildMuseMspSpawnInput({ binaryPath: "muse" }, "/tmp/project", { MUSE_API_KEY: "x" }),
    ).toEqual({
      command: "muse",
      args: ["serve"],
      cwd: "/tmp/project",
      env: { MUSE_API_KEY: "x" },
    });
  });
});
