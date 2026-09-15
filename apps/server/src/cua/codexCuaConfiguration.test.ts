import * as NodeAssert from "node:assert/strict";

import { parse as parseToml } from "smol-toml";
import { describe, it } from "vite-plus/test";

import { buildCuaDriverAppServerArgs, hasConfiguredCuaDriver } from "./codexCuaConfiguration.ts";

describe("hasConfiguredCuaDriver", () => {
  it.each([
    '[mcp_servers.cua-driver]\ncommand = "custom"',
    '["mcp_servers"."cua-driver"]\nenabled = false',
    "['mcp_servers'.'cua-driver']\nargs = []",
    'mcp_servers = { "cua-driver" = { command = "custom" } }',
    'mcp_servers . "cua-driver" . command = "custom"',
  ])("preserves a configured server in TOML: %s", (config) => {
    NodeAssert.equal(hasConfiguredCuaDriver([], config), true);
  });

  it.each(["-c", "--config", "-c=", "--config=", "-cattached"])(
    "detects explicit overrides with %s",
    (flag) => {
      const override = '"mcp_servers" . "cua-driver" . command = custom-driver';
      const argv =
        flag === "-cattached"
          ? [`-c${override}`]
          : flag.endsWith("=")
            ? [`${flag}${override}`]
            : [flag, override];
      NodeAssert.equal(hasConfiguredCuaDriver(argv, undefined), true);
    },
  );

  it("detects inline table overrides and explicit disablement", () => {
    NodeAssert.equal(
      hasConfiguredCuaDriver(["-c", 'mcp_servers = { "cua-driver" = { enabled = false } }'], ""),
      true,
    );
  });

  it("ignores unrelated servers, comments, string values and similarly named keys", () => {
    NodeAssert.equal(
      hasConfiguredCuaDriver(
        ["--config", "model = gpt-5", "-c", 'mcp_servers.other.command = "cua-driver"'],
        '# [mcp_servers.cua-driver]\n[mcp_servers.cua-driver-backup]\ncommand = "cua-driver"\n[other.mcp_servers.cua-driver]\ncommand = "custom"',
      ),
      false,
    );
    NodeAssert.equal(hasConfiguredCuaDriver([], '"mcp_servers.cua-driver" = {}'), false);
  });

  it("respects argument boundaries without consuming adjacent flags", () => {
    NodeAssert.equal(
      hasConfiguredCuaDriver(["--", "-c", "mcp_servers.cua-driver = {}"], ""),
      false,
    );
    NodeAssert.equal(hasConfiguredCuaDriver(["--config", "--strict-config", "-c"], ""), false);
    NodeAssert.equal(
      hasConfiguredCuaDriver(["--config", "--config=mcp_servers.cua-driver = {}"], ""),
      true,
    );
    NodeAssert.equal(hasConfiguredCuaDriver(["mcp_servers.cua-driver = {}"], ""), false);
  });

  it("conservatively suppresses injection when configuration is malformed", () => {
    NodeAssert.equal(hasConfiguredCuaDriver([], "[broken"), true);
    NodeAssert.equal(hasConfiguredCuaDriver(["-c", "mcp_servers = { broken"], ""), true);
    NodeAssert.equal(hasConfiguredCuaDriver(["--config=broken"], ""), true);
    NodeAssert.equal(hasConfiguredCuaDriver([], undefined), false);
  });
});

describe("buildCuaDriverAppServerArgs", () => {
  it("round-trips command, argv and environment without shell interpretation", () => {
    const descriptor = {
      command: 'C:\\Program Files\\Cua\\driver "preview".exe',
      args: ["mcp", "--path", "/a path/with spaces", "", "$(echo untouched)", "line\n\t\u007f"],
      environment: [
        { name: "DOT.KEY", value: 'C:\\a path\\"file"' },
        { name: 'QUOTED"KEY', value: "line\nreturn\r\t\b\f\u0000" },
        { name: "SPACE KEY", value: "emoji: \u{1f600}" },
      ],
    };
    const argv = buildCuaDriverAppServerArgs(descriptor);
    NodeAssert.equal(argv.length, 2);
    NodeAssert.equal(argv[0], "-c");
    NodeAssert.deepStrictEqual(parseToml(argv[1]!), {
      mcp_servers: {
        "cua-driver": {
          command: descriptor.command,
          args: descriptor.args,
          env: Object.fromEntries(descriptor.environment.map(({ name, value }) => [name, value])),
        },
      },
    });
    NodeAssert.equal(hasConfiguredCuaDriver(argv, undefined), true);
  });

  it("encodes empty args and environment as TOML collections", () => {
    const argv = buildCuaDriverAppServerArgs({ command: "driver", args: [], environment: [] });
    NodeAssert.deepStrictEqual(parseToml(argv[1]!), {
      mcp_servers: { "cua-driver": { command: "driver", args: [], env: {} } },
    });
  });
});
