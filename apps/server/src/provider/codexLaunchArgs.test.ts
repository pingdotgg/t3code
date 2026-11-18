import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it.each([
    {
      name: "preserves escaped TOML quotes in config values",
      launchArgs: String.raw`--config model=\"gpt-6.1-sol\" --strict-config`,
      expected: ["--config", 'model="gpt-6.1-sol"', "--strict-config"],
    },
    {
      name: "lets launch args override the unload delay",
      launchArgs: "-c thread_unload_delay_secs=1800",
      expected: ["-c", "thread_unload_delay_secs=1800"],
    },
  ])("asks Codex to unload unsubscribed threads immediately and $name", (row) => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(row.launchArgs, undefined), [
      "app-server",
      "-c",
      "thread_unload_delay_secs=0",
      ...row.expected,
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs(
        '--strict-config --enable foo --listen off --config model="gpt 5"',
        undefined,
      ),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("drops launch args that enable user hooks", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs(
        "--enable hooks --enable=hooks --enable codex_hooks --enable=codex_hooks --enable foo --disable hooks",
        undefined,
      ),
      ["--enable", "foo", "--disable", "hooks"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs("--config --strict-config --enable --disable", undefined),
      ["--strict-config"],
    );
  });
});

describe("codex exec and mcp list launch args", () => {
  const launchArgs =
    "--strict-config --oss --local-provider ollama --profile local -p=work --listen off --enable foo";

  it("keeps the local model provider flags for codex exec", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs, undefined), [
      "--strict-config",
      "--oss",
      "--local-provider",
      "ollama",
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });

  it("keeps the selected profile and drops exec-only flags for codex mcp list", () => {
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs, undefined), [
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });
});

describe("pinned SQLite home", () => {
  // regression: #24486 a sqlite_home in any Codex config layer outranked CODEX_SQLITE_HOME.
  it("puts the SQLite home T3 validated after the launch args of every Codex command", () => {
    const environment = { T3CODE_CODEX_SQLITE_HOME: String.raw`C:\Users\me\.codex` };
    const pin = ["-c", String.raw`sqlite_home='C:\Users\me\.codex'`];

    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config", environment), [
      "app-server",
      "-c",
      "thread_unload_delay_secs=0",
      "--strict-config",
      ...pin,
    ]);
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--strict-config", environment), [
      "--strict-config",
      ...pin,
    ]);
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs("--enable foo", environment), [
      "--enable",
      "foo",
      ...pin,
    ]);
    // A TOML literal string cannot hold an apostrophe.
    NodeAssert.deepStrictEqual(
      codexMcpListLaunchArgs("", { T3CODE_CODEX_SQLITE_HOME: String.raw`C:\O'Neil\.codex` }),
      ["-c", String.raw`sqlite_home="C:\\O'Neil\\.codex"`],
    );
  });
});
