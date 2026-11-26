import { describe, expect, it } from "@effect/vitest";

import { codexAddPlan, codexSpecFromGet, parseCodexMcpList } from "./codexExtensions.ts";

const stdio = (overrides: Record<string, unknown> = {}) => ({
  type: "stdio",
  command: "npx",
  args: ["-y", "runpod-mcp"],
  env: { RUNPOD_API_KEY: "rp_env_secret" },
  env_vars: ["PATH"],
  cwd: null,
  ...overrides,
});

const http = (overrides: Record<string, unknown> = {}) => ({
  type: "streamable_http",
  url: "https://mcp.example.com/mcp",
  bearer_token_env_var: null,
  http_headers: null,
  env_http_headers: null,
  http_headers_helper: null,
  ...overrides,
});

const row = (name: string, transport: object, extra: Record<string, unknown> = {}) => ({
  name,
  enabled: true,
  disabled_reason: null,
  transport,
  startup_timeout_sec: null,
  tool_timeout_sec: null,
  auth_status: "unsupported",
  ...extra,
});

describe("parseCodexMcpList", () => {
  it("maps transports, health and secret names without secret values", () => {
    const output = JSON.stringify([
      row("runpod", stdio()),
      row("off", stdio({ env: null, env_vars: [] }), { enabled: false, disabled_reason: "manual" }),
      row("oauth", http(), { auth_status: "not_logged_in" }),
      row("signed-in", http(), { auth_status: "o_auth" }),
      row("header", http({ http_headers: { Authorization: "Bearer header_secret" } }), {
        auth_status: "not_logged_in",
      }),
      row("bearer", http({ bearer_token_env_var: "TOKEN_VAR" }), { auth_status: "bearer_token" }),
      row("odd", http(), { auth_status: "something_new" }),
      row("ws", { type: "websocket", url: "wss://x" }),
    ]);
    const servers = parseCodexMcpList(output);
    expect(
      servers?.map((server) => [
        server.name,
        server.transport,
        server.enabled,
        server.health,
        server.detail,
        server.secretNames,
      ]),
    ).toEqual([
      ["runpod", "stdio", true, "ok", null, ["RUNPOD_API_KEY", "PATH"]],
      ["off", "stdio", false, "disabled", "manual", []],
      ["oauth", "http", true, "needsAuth", "Not signed in", []],
      ["signed-in", "http", true, "ok", null, []],
      ["header", "http", true, "ok", null, ["Authorization"]],
      ["bearer", "http", true, "ok", null, ["TOKEN_VAR"]],
      ["odd", "http", true, "unknown", "something_new", []],
    ]);
    const reported = JSON.stringify(servers);
    expect(reported).not.toContain("rp_env_secret");
    expect(reported).not.toContain("header_secret");
    expect(parseCodexMcpList("WARNING: not json")).toBeUndefined();
  });
});

describe("codexSpecFromGet", () => {
  it("keeps values server-side and names what a copy can't carry", () => {
    expect(codexSpecFromGet(JSON.stringify(row("runpod", stdio())))).toEqual({
      spec: {
        _tag: "stdio",
        command: "npx",
        args: ["-y", "runpod-mcp"],
        env: { RUNPOD_API_KEY: "rp_env_secret" },
      },
      notCopied: ["forwarded env var PATH"],
    });
    expect(
      codexSpecFromGet(
        JSON.stringify(
          row(
            "gh",
            http({
              http_headers: { Authorization: "Bearer x" },
              env_http_headers: { "X-Key": "KEY_VAR" },
              bearer_token_env_var: "TOKEN_VAR",
            }),
          ),
        ),
      ),
    ).toEqual({
      spec: {
        _tag: "remote",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer x" },
      },
      notCopied: ["header X-Key", "bearer token from TOKEN_VAR"],
    });
  });
});

describe("codexAddPlan", () => {
  it("puts flags before the name and reports headers Codex can't store", () => {
    expect(
      codexAddPlan("fs", { _tag: "stdio", command: "npx", args: ["-y", "fs"], env: { A: "1" } }),
    ).toEqual({
      _tag: "run",
      args: ["mcp", "add", "--env", "A=1", "fs", "--", "npx", "-y", "fs"],
      notSet: [],
    });
    expect(
      codexAddPlan("api", {
        _tag: "remote",
        transport: "http",
        url: "https://x.dev/mcp",
        headers: { Authorization: "Bearer t" },
      }),
    ).toEqual({
      _tag: "run",
      args: ["mcp", "add", "api", "--url", "https://x.dev/mcp"],
      notSet: ["header Authorization"],
    });
    expect(
      codexAddPlan("sse", { _tag: "remote", transport: "sse", url: "https://x.dev", headers: {} })
        ._tag,
    ).toBe("unsupported");
  });
});
