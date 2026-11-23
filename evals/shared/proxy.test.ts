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
});
