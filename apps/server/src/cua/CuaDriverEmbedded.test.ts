import { describe, expect, it } from "vite-plus/test";

import { buildCodexLaunchArgs, buildCodexThreadConfig } from "./CuaDriverEmbedded.ts";

const connection = {
  mcp: {
    command: "/Applications/T3 Code/cua-driver",
    args: ["mcp", "--embedded", "--socket", "/tmp/t3 code.sock"],
    environment: [
      { name: "CUA_DRIVER_EMBEDDED", value: "1" },
      { name: "CUA_DRIVER_HOST_BUNDLE_ID", value: "com.t3tools.t3code" },
    ],
  },
};

describe("embedded cua-driver Codex configuration", () => {
  it("quotes MCP launch arguments", () => {
    expect(buildCodexLaunchArgs(connection)).toBe(
      '-c "mcp_servers.cua-driver.command=\\"/Applications/T3 Code/cua-driver\\"" -c "mcp_servers.cua-driver.args=[\\"mcp\\",\\"--embedded\\",\\"--socket\\",\\"/tmp/t3 code.sock\\"]" -c "mcp_servers.cua-driver.env={CUA_DRIVER_EMBEDDED=\\"1\\",CUA_DRIVER_HOST_BUNDLE_ID=\\"com.t3tools.t3code\\"}"',
    );
  });

  it("builds structured thread configuration", () => {
    expect(JSON.parse(buildCodexThreadConfig(connection))).toEqual({
      mcp_servers: {
        "cua-driver": {
          command: "/Applications/T3 Code/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/tmp/t3 code.sock"],
          env: {
            CUA_DRIVER_EMBEDDED: "1",
            CUA_DRIVER_HOST_BUNDLE_ID: "com.t3tools.t3code",
          },
        },
      },
    });
  });

  it("preserves configuration from earlier integrations", () => {
    expect(
      JSON.parse(
        buildCodexThreadConfig(
          connection,
          '{"features":{"example":true},"mcp_servers":{"existing":{"command":"existing"}}}',
        ),
      ),
    ).toEqual({
      features: { example: true },
      mcp_servers: {
        existing: { command: "existing" },
        "cua-driver": {
          command: "/Applications/T3 Code/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/tmp/t3 code.sock"],
          env: {
            CUA_DRIVER_EMBEDDED: "1",
            CUA_DRIVER_HOST_BUNDLE_ID: "com.t3tools.t3code",
          },
        },
      },
    });
  });
});
