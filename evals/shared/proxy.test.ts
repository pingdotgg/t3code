import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { proxyConfig } from "./proxy.ts";

const config = `model_provider = "cliproxy"

[model_providers.cliproxy]
base_url = "https://proxy.example/v1"
requires_openai_auth = true
`;

// Runs proxyConfig against a fresh CODEX_HOME holding `files`, with only `env` set.
const run = Effect.fn("run")(function* (
  files: Record<string, string>,
  env: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-evals-proxy-" });
  for (const [name, content] of Object.entries(files)) {
    yield* fs.writeFileString(path.join(home, name), content);
  }
  return yield* proxyConfig().pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...env, CODEX_HOME: home } })),
    ),
  );
});

it.layer(NodeServices.layer)("proxyConfig", (it) => {
  it.effect.each([
    ["no auth.json", undefined],
    ["a ChatGPT-login auth.json", { OPENAI_API_KEY: null, tokens: { access_token: "t" } }],
  ] as const)("fails when the provider requires OpenAI auth and %s has no key", ([, auth]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run({
          "config.toml": config,
          ...(auth ? { "auth.json": JSON.stringify(auth) } : {}),
        }),
      );
      assert.match(error.message, /requires_openai_auth/);
    }).pipe(Effect.scoped),
  );

  it.effect("reads the named provider's URL, headers and key", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          "config.toml": `model_provider = "openai"

[model_providers.cliproxy]
base_url = "https://proxy.example/v1/"
env_key = "EVAL_PROXY_KEY"
http_headers = { "X-Client" = "evals" }
env_http_headers = { "X-Account" = "EVAL_PROXY_ACCOUNT" }
`,
        },
        {
          T3CODE_EVAL_MODEL_PROVIDER: "cliproxy",
          EVAL_PROXY_KEY: "k",
          EVAL_PROXY_ACCOUNT: "a",
        },
      );
      assert.deepStrictEqual(result, {
        url: "https://proxy.example/v1",
        headers: { "X-Client": "evals", "X-Account": "a", Authorization: "Bearer k" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports malformed TOML without including nearby credentials", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run({
          "config.toml":
            '[model_providers.cliproxy]\nexperimental_bearer_token = "fixture-key"\n@invalid\n',
        }),
      );
      assert.match(error.message, /^Invalid TOML at .* \(line 3, column 1\)\.[^\n]+$/);
      assert.notInclude(error.message, "fixture-key");
    }).pipe(Effect.scoped),
  );
});
