/**
 * No-tool / MCP-suppression guarantee for locally-spawned OpenCode servers.
 *
 * Every t3code-spawned OpenCode server must run with an EMPTY config
 * (`OPENCODE_CONFIG_CONTENT="{}"`) so the user's opencode.json / global config —
 * MCP servers, custom instructions, plugins — is never loaded. This is the
 * OpenCode analog of the Claude `--strict-mcp-config --mcp-config "{}"` and
 * Codex `--ignore-user-config` postures, and pairs with the per-session
 * `permission "*" deny` rule asserted in OpenCodeTextGeneration.test.ts.
 */
import { describe, expect, it } from "vite-plus/test";

import { buildOpenCodeServeSpawn } from "./opencodeRuntime.ts";

describe("buildOpenCodeServeSpawn (MCP/config suppression)", () => {
  it("forces an EMPTY config so no MCP servers, instructions, or plugins load", () => {
    const { env } = buildOpenCodeServeSpawn({
      hostname: "127.0.0.1",
      port: 4399,
      environment: { PATH: "/usr/bin", OPENCODE_CONFIG: "/home/u/opencode.json" },
    });
    // The empty-config override wins regardless of inherited env.
    expect(env.OPENCODE_CONFIG_CONTENT).toBe("{}");
    // Inherited env is otherwise preserved (auth/PATH still available).
    expect(env.PATH).toBe("/usr/bin");
  });

  it("serves on the requested hostname/port", () => {
    const { args } = buildOpenCodeServeSpawn({ hostname: "127.0.0.1", port: 4399 });
    expect(args).toEqual(["serve", "--hostname=127.0.0.1", "--port=4399"]);
  });
});
