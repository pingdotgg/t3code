import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

/**
 * Stand-in for a Codex app-server whose online catalog refresh failed: it
 * answers `model/list` from its bundled OpenAI models and never rewrites
 * `models_cache.json`, leaving the last good custom-provider catalog there.
 */
const makeFakeCodexAppServer = (configReadResult: string) => String.raw`#!/usr/bin/env node
const path = require("node:path");
const readline = require("node:readline");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const configReadResult = ${configReadResult};
const bundledModel = {
  id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "",
  hidden: false, isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], serviceTiers: [],
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.166.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
  } else if (method === "account/read") {
    write({ id, result: { account: null, requiresOpenaiAuth: false } });
  } else if (method === "config/read") {
    write({ id, ...configReadResult });
  } else if (method === "model/list") {
    write({ id, result: { data: [bundledModel], nextCursor: null } });
  } else if (method === "skills/list") {
    write({ id, result: { data: [] } });
  } else if (method === "account/rateLimits/read") {
    write({ id, result: null });
  } else {
    write({ id, error: { code: -32601, message: "unsupported" } });
  }
});
`;

const FAKE_CODEX_CUSTOM_PROVIDER_APP_SERVER = makeFakeCodexAppServer(
  `{ result: { config: { model_provider: "openrouter" }, origins: {} } }`,
);
const FAKE_CODEX_UNREADABLE_CONFIG_APP_SERVER = makeFakeCodexAppServer(
  `{ error: { code: -32603, message: "config unavailable" } }`,
);

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const cachedCustomModel = {
  slug: "deepseek/deepseek-v4.1-flash-1017",
  display_name: "DeepSeek: DeepSeek V4.1 Flash 1017",
  description: "DeepSeek's coding model.",
  supported_reasoning_levels: [
    { effort: "low", description: "Faster" },
    { effort: "high", description: "Deeper" },
  ],
  default_reasoning_level: "high",
  visibility: "list",
  supported_in_api: true,
};

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "Codex custom provider catalog",
  (it) => {
    it.effect(
      "keeps the last custom-provider catalog when Codex falls back to bundled models",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
          const binaryPath = path.join(dir, "codex");
          yield* fs.writeFileString(binaryPath, FAKE_CODEX_CUSTOM_PROVIDER_APP_SERVER);
          yield* fs.chmod(binaryPath, 0o755);
          yield* fs.writeFileString(
            path.join(dir, "models_cache.json"),
            JSON.stringify({
              fetched_at: DateTime.formatIso(
                DateTime.subtract(yield* DateTime.now, { minutes: 10 }),
              ),
              models: [cachedCustomModel],
            }),
          );

          const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
          const provider = yield* checkCodexProviderStatus(
            decodeCodexSettings({ binaryPath, homePath: dir }),
            undefined,
            environment,
          );

          assert.deepStrictEqual(
            provider.models.map((model) => model.slug),
            ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash-1017"],
          );
          const deepseek = provider.models.find(
            (model) => model.slug === "deepseek/deepseek-v4.1-flash-1017",
          );
          const reasoning = deepseek?.capabilities?.optionDescriptors?.find(
            (descriptor) => descriptor.id === "reasoningEffort",
          );
          assert.deepStrictEqual(
            reasoning?.type === "select" ? reasoning.options.map((option) => option.id) : [],
            ["low", "high"],
          );
        }).pipe(Effect.scoped),
    );

    it.effect("keeps valid cached models beside malformed cache entries", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
        const binaryPath = path.join(dir, "codex");
        yield* fs.writeFileString(binaryPath, FAKE_CODEX_CUSTOM_PROVIDER_APP_SERVER);
        yield* fs.chmod(binaryPath, 0o755);
        yield* fs.writeFileString(
          path.join(dir, "models_cache.json"),
          JSON.stringify({
            fetched_at: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 10 })),
            models: [{ slug: 42 }, cachedCustomModel, null],
          }),
        );

        const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
        const provider = yield* checkCodexProviderStatus(
          decodeCodexSettings({ binaryPath, homePath: dir }),
          undefined,
          environment,
        );

        assert.deepStrictEqual(
          provider.models.map((model) => model.slug),
          ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash-1017"],
        );
      }).pipe(Effect.scoped),
    );

    it.effect("keeps the last custom-provider catalog when config cannot be read", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
        const binaryPath = path.join(dir, "codex");
        yield* fs.writeFileString(binaryPath, FAKE_CODEX_UNREADABLE_CONFIG_APP_SERVER);
        yield* fs.chmod(binaryPath, 0o755);
        yield* fs.writeFileString(
          path.join(dir, "models_cache.json"),
          JSON.stringify({
            fetched_at: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 10 })),
            models: [cachedCustomModel],
          }),
        );

        const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
        const provider = yield* checkCodexProviderStatus(
          decodeCodexSettings({ binaryPath, homePath: dir }),
          undefined,
          environment,
        );

        assert.deepStrictEqual(
          provider.models.map((model) => model.slug),
          ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash-1017"],
        );
      }).pipe(Effect.scoped),
    );
  },
);
