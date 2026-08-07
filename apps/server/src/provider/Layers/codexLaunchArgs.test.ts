import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  hasConfiguredCuaDriver,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });

  it("appends integration arguments without replacing configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs("--strict-config", {
        T3CODE_CODEX_APPEND_LAUNCH_ARGS: '-c mcp_servers.cua-driver.command="/bin/cua-driver"',
      }),
      '--strict-config -c mcp_servers.cua-driver.command="/bin/cua-driver"',
    );
  });

  it("uses T3's managed Cua Driver when no existing configuration is present", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(
        "--strict-config",
        {
          T3CODE_CODEX_CUA_LAUNCH_ARGS: '-c mcp_servers.cua-driver.command="/bundled/cua-driver"',
        },
        {},
      ),
      '--strict-config -c mcp_servers.cua-driver.command="/bundled/cua-driver"',
    );
  });

  it("lets an existing Codex Cua Driver configuration win", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(
        "--strict-config",
        {
          T3CODE_CODEX_APPEND_LAUNCH_ARGS: "--enable foo",
          T3CODE_CODEX_CUA_LAUNCH_ARGS: '-c mcp_servers.cua-driver.command="/bundled/cua-driver"',
        },
        {
          configToml: '[mcp_servers.cua-driver]\ncommand = "/existing/cua-driver"\n',
        },
      ),
      "--strict-config --enable foo",
    );
  });

  it("lets an explicit Cua Driver launch override win", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(
        '-c mcp_servers."cua-driver".command="/existing/cua-driver"',
        {
          T3CODE_CODEX_CUA_LAUNCH_ARGS: '-c mcp_servers.cua-driver.command="/bundled/cua-driver"',
        },
        {},
      ),
      '-c mcp_servers."cua-driver".command="/existing/cua-driver"',
    );
  });

  it("lets an appended Cua Driver launch override win", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs("--strict-config", {
        T3CODE_CODEX_APPEND_LAUNCH_ARGS: '-c mcp_servers.cua-driver.command="/existing/cua-driver"',
        T3CODE_CODEX_CUA_LAUNCH_ARGS: '-c mcp_servers.cua-driver.command="/bundled/cua-driver"',
      }),
      '--strict-config -c mcp_servers.cua-driver.command="/existing/cua-driver"',
    );
  });
});

describe("hasConfiguredCuaDriver", () => {
  it("detects quoted and unquoted Codex MCP tables", () => {
    NodeAssert.equal(
      hasConfiguredCuaDriver("", '[mcp_servers.cua-driver]\ncommand = "/bin/cua-driver"'),
      true,
    );
    NodeAssert.equal(
      hasConfiguredCuaDriver("", '[mcp_servers."cua-driver"]\ncommand = "/bin/cua-driver"'),
      true,
    );
  });

  it("ignores unrelated and malformed Codex configuration", () => {
    NodeAssert.equal(
      hasConfiguredCuaDriver("", '[mcp_servers.other]\ncommand = "/bin/other"'),
      false,
    );
    NodeAssert.equal(hasConfiguredCuaDriver("", "not valid toml = ["), false);
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
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
