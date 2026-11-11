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
    NodeAssert.deepStrictEqual(codexAppServerArgs(row.launchArgs), [
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
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("codex exec and mcp list launch args", () => {
  const launchArgs =
    "--strict-config --oss --local-provider ollama --profile local -p=work --listen off --enable foo";

  it("keeps the local model provider flags for codex exec", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs), [
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
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs), [
      "--profile",
      "local",
      "-p=work",
      "--enable",
      "foo",
    ]);
  });
});
