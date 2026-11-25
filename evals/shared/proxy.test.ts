// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { proxyConfig } from "./proxy.ts";

const config = `model_provider = "cliproxy"

[model_providers.cliproxy]
base_url = "https://proxy.example/v1"
requires_openai_auth = true
`;

describe("proxyConfig", () => {
  it.each([
    ["no auth.json", undefined],
    ["a ChatGPT-login auth.json", { OPENAI_API_KEY: null, tokens: { access_token: "t" } }],
  ])("fails when the provider requires OpenAI auth and %s has no key", (_, auth) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-evals-proxy-"));
    using _home = {
      [Symbol.dispose]: () => {
        vi.unstubAllEnvs();
        NodeFS.rmSync(home, { recursive: true });
      },
    };
    NodeFS.writeFileSync(NodePath.join(home, "config.toml"), config);
    if (auth) NodeFS.writeFileSync(NodePath.join(home, "auth.json"), JSON.stringify(auth));
    vi.stubEnv("CODEX_HOME", home);
    expect(() => proxyConfig()).toThrow(/requires_openai_auth/);
  });

  it("reads the named provider's URL, headers and key without Python", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-evals-proxy-"));
    using _home = {
      [Symbol.dispose]: () => {
        vi.unstubAllEnvs();
        NodeFS.rmSync(home, { recursive: true });
      },
    };
    NodeFS.writeFileSync(
      NodePath.join(home, "config.toml"),
      `model_provider = "openai"

[model_providers.cliproxy]
base_url = "https://proxy.example/v1/"
env_key = "EVAL_PROXY_KEY"
http_headers = { "X-Client" = "evals" }
env_http_headers = { "X-Account" = "EVAL_PROXY_ACCOUNT" }
`,
    );
    vi.stubEnv("PATH", home);
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("T3CODE_EVAL_MODEL_PROVIDER", "cliproxy");
    vi.stubEnv("EVAL_PROXY_KEY", "k");
    vi.stubEnv("EVAL_PROXY_ACCOUNT", "a");
    expect(proxyConfig()).toEqual({
      url: "https://proxy.example/v1",
      headers: { "X-Client": "evals", "X-Account": "a", Authorization: "Bearer k" },
    });
  });

  it("reports malformed TOML without including nearby credentials", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-evals-proxy-"));
    using _home = {
      [Symbol.dispose]: () => {
        vi.unstubAllEnvs();
        NodeFS.rmSync(home, { recursive: true });
      },
    };
    NodeFS.writeFileSync(
      NodePath.join(home, "config.toml"),
      '[model_providers.cliproxy]\nexperimental_bearer_token = "fixture-key"\n@invalid\n',
    );
    vi.stubEnv("CODEX_HOME", home);
    expect(() => proxyConfig()).toThrow(/^Invalid TOML at .* \(line 3, column 1\)\.[^\n]+$/);
  });
});
