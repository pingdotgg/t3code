// @effect-diagnostics nodeBuiltinImport:off -- Reads isolated provider configuration fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, vi } from "vite-plus/test";

import { morphConfig, proxyConfig } from "./proxy.ts";

it.live.each(["v1", "v2", "environment"] as const)(
  "reads Morph credentials from %s without a model request",
  (source) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configHome = yield* fs.makeTempDirectoryScoped({ prefix: "morph-eval-config-" });
      const settings = { apiKey: "eval-config-key", baseURL: "https://config.invalid/v1/" };
      if (source !== "environment") {
        yield* fs.makeDirectory(`${configHome}/opencode`);
        yield* fs.writeFileString(
          `${configHome}/opencode/opencode.json`,
          JSON.stringify(
            source === "v1"
              ? { provider: { morph: { options: settings } } }
              : { providers: { morph: { settings } } },
          ),
        );
      }
      vi.stubEnv("XDG_CONFIG_HOME", configHome);
      vi.stubEnv("MORPH_API_KEY", source === "environment" ? "eval-environment-key" : undefined);
      vi.stubEnv(
        "MORPH_BASE_URL",
        source === "environment" ? "https://environment.invalid/v1/" : undefined,
      );
      try {
        expect(morphConfig()).toEqual({
          url:
            source === "environment"
              ? "https://environment.invalid/v1"
              : "https://config.invalid/v1",
          headers: {
            Authorization: `Bearer ${source === "environment" ? "eval-environment-key" : "eval-config-key"}`,
          },
        });
      } finally {
        vi.unstubAllEnvs();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

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
