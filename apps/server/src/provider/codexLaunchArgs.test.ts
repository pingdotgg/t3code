import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it.each([
    {
      name: "preserves escaped TOML quotes in config values",
      launchArgs: String.raw`--config model=\"gpt-6.1-sol\" --strict-config`,
      version: "0.167.0",
      expected: ["--config", 'model="gpt-6.1-sol"', "--strict-config"],
    },
    {
      name: "lets launch args override the unload delay",
      launchArgs: "-c thread_unload_delay_secs=1800",
      expected: ["-c", "thread_unload_delay_secs=1800"],
    },
    {
      name: "preserves an escaped trailing space in the environment override",
      launchArgs: "--strict-config",
      environment: { T3CODE_CODEX_LAUNCH_ARGS: "--cloud-skills-snapshot skills.json\\ " },
      expected: ["--cloud-skills-snapshot", "skills.json "],
    },
    {
      name: "uses configured arguments when the environment override is blank",
      launchArgs: "--strict-config",
      environment: { T3CODE_CODEX_LAUNCH_ARGS: " \t " },
      version: "0.167.0",
      expected: ["--strict-config"],
    },
  ])("asks Codex to unload unsubscribed threads immediately and $name", (row) => {
    const launchArgs = resolveCodexLaunchArgs(row.launchArgs, row.environment ?? {});
    NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs, row.version), [
      "app-server",
      "-c",
      "thread_unload_delay_secs=0",
      ...row.expected,
    ]);
  });

  it.each(["0.153.0", null])(
    "keeps strict config on Codex %s without adding an unknown key",
    (version) => {
      NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config", version), [
        "app-server",
        "--strict-config",
      ]);
    },
  );
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("keeps user hooks, apps, and plugins off during text generation", () => {
    const launchArgs =
      "--enable hooks --enable=hooks --enable codex_hooks --enable=codex_hooks --enable apps --enable=apps --enable connectors --enable=connectors --enable plugins --enable=plugins --enable foo --disable hooks";
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs), [
      "--enable",
      "foo",
      "--disable",
      "hooks",
    ]);
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs), [
      "--enable",
      "hooks",
      "--enable=hooks",
      "--enable",
      "codex_hooks",
      "--enable=codex_hooks",
      "--enable",
      "foo",
      "--disable",
      "hooks",
    ]);
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe.each(["", "="])("codex exec and mcp list launch args with -p%swork", (separator) => {
  const launchArgs = `--strict-config --oss --local-provider ollama --profile local -p${separator}work -c${separator}model_provider=ollama --listen off --enable foo`;

  it("keeps the local model provider flags for codex exec", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs), [
      "--strict-config",
      "--oss",
      "--local-provider",
      "ollama",
      "--profile",
      "local",
      "-p=work",
      "-c=model_provider=ollama",
      "--enable",
      "foo",
    ]);
  });

  it("keeps the selected profile and drops exec-only flags for codex mcp list", () => {
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs), [
      "--profile",
      "local",
      "-p=work",
      "-c=model_provider=ollama",
      "--enable",
      "foo",
    ]);
  });
});
