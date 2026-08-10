import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { McpServerConfig, McpServerConfigMap, McpServerId } from "./mcpServers.ts";

const decodeConfig = Schema.decodeUnknownSync(McpServerConfig);
const encodeConfig = Schema.encodeSync(McpServerConfig);
const decodeConfigMap = Schema.decodeUnknownSync(McpServerConfigMap);

describe("McpServerConfig", () => {
  it("round-trips a stdio server", () => {
    const parsed = decodeConfig({
      name: "Filesystem",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: [{ name: "DEBUG", value: "1", sensitive: false }],
      },
    });

    expect(parsed.enabled).toBe(true); // defaults to true when omitted
    expect(parsed.transport.type).toBe("stdio");
    expect(encodeConfig(parsed)).toMatchObject({
      name: "Filesystem",
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
    });
  });

  it("round-trips an http server with a sensitive header", () => {
    const parsed = decodeConfig({
      name: "Remote",
      enabled: false,
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer abc", sensitive: true }],
      },
    });

    expect(parsed.enabled).toBe(false);
    if (parsed.transport.type === "stdio") throw new Error("expected http transport");
    expect(parsed.transport.url).toBe("https://example.com/mcp");
    expect(parsed.transport.headers?.[0]).toMatchObject({
      name: "Authorization",
      value: "Bearer abc",
      sensitive: true,
    });
  });

  it("rejects a transport that is neither stdio nor http/sse", () => {
    expect(() =>
      decodeConfig({
        name: "Broken",
        transport: { type: "carrier-pigeon", url: "https://example.com" },
      }),
    ).toThrow();
  });

  it("decodes a map keyed by server id", () => {
    const map = decodeConfigMap({
      "server-1": {
        name: "One",
        transport: { type: "stdio", command: "npx", args: [] },
      },
    });

    expect(Object.keys(map)).toEqual(["server-1"]);
    expect(map[McpServerId.make("server-1")]?.name).toBe("One");
  });
});
