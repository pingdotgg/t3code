import { describe, expect, it } from "vitest";
import {
  buildWslExecArgs,
  buildWslShellArgs,
  buildWslShellCommandArgs,
  parseWslListVerbose,
} from "./WslCli.ts";

describe("WslCli", () => {
  it("builds direct exec arguments", () => {
    expect(
      buildWslExecArgs(
        { kind: "wsl", distroName: "Ubuntu", user: "me" },
        "/home/me/project",
        "codex",
        ["app-server"],
      ),
    ).toEqual([
      "--distribution",
      "Ubuntu",
      "--user",
      "me",
      "--cd",
      "/home/me/project",
      "--exec",
      "codex",
      "app-server",
    ]);
  });

  it("builds shell arguments", () => {
    expect(buildWslShellArgs({ kind: "wsl", distroName: "Ubuntu" }, "/tmp", "pwd")).toEqual([
      "--distribution",
      "Ubuntu",
      "--cd",
      "/tmp",
      "--exec",
      "sh",
      "-lc",
      "pwd",
    ]);
  });

  it("builds shell arguments with positional parameters", () => {
    expect(
      buildWslShellCommandArgs({ kind: "wsl", distroName: "Ubuntu" }, "/", 'command -v "$1"', [
        "codex",
      ]),
    ).toEqual([
      "--distribution",
      "Ubuntu",
      "--cd",
      "/",
      "--exec",
      "sh",
      "-lc",
      'command -v "$1"',
      "t3-wsl-shell",
      "codex",
    ]);
  });

  it("parses verbose distribution output", () => {
    expect(
      parseWslListVerbose(`  NAME                   STATE           VERSION
* Ubuntu                 Running         2
  Debian                 Stopped         2
`),
    ).toEqual([
      { name: "Ubuntu", default: true, running: true, version: 2 },
      { name: "Debian", default: false, running: false, version: 2 },
    ]);
  });
});
