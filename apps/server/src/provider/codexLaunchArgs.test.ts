import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  applyCodexProxyRuntime,
  codexAppServerArgs,
  codexExecLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
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

describe("applyCodexProxyRuntime", () => {
  const proxyProvider =
    'model_providers.t3_proxy={name="T3 proxy",base_url="http://proxy:8317/v1",env_key="T3_PROXY_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=false}';

  it("adds the proxy provider after env launch args and keeps the key out of argv", () => {
    const { config, environment } = applyCodexProxyRuntime(
      { launchArgs: "--ignored" },
      { T3CODE_CODEX_LAUNCH_ARGS: "--strict-config", PATH: "/bin" },
      { url: "http://proxy:8317", apiKey: "sk-proxy" },
    );

    NodeAssert.deepStrictEqual(codexAppServerArgs(config.launchArgs), [
      "app-server",
      "--strict-config",
      "-c",
      'model_provider="t3_proxy"',
      "-c",
      proxyProvider,
    ]);
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(config.launchArgs).slice(-2), [
      "-c",
      proxyProvider,
    ]);
    NodeAssert.deepStrictEqual(environment, { PATH: "/bin", T3_PROXY_KEY: "sk-proxy" });
  });
});
