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
const FAKE_CODEX_UNREADABLE_CONFIG_APP_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const bundledModel = {
  id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "",
  hidden: false, isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], serviceTiers: [],
};
let modelLists = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.166.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
  } else if (method === "account/read") {
    write({ id, result: { account: null, requiresOpenaiAuth: false } });
  } else if (method === "config/read") {
    write({ id, error: { code: -32603, message: "config unavailable" } });
  } else if (method === "model/list") {
    modelLists += 1;
    fs.writeFileSync(process.env.CODEX_HOME + "/models_cache.json", process.env.CODEX_TEST_CACHE);
    if (modelLists > 1) {
      write({ id, error: { code: -32603, message: "catalog refresh failed" } });
      return;
    }
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

const FAKE_CODEX_SLOW_CONFIG_APP_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const log = (method) => fs.appendFileSync(process.env.CODEX_TEST_LOG, method + "\n");
const bundledModel = {
  id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "",
  hidden: false, isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], serviceTiers: [],
};
let releaseConfigRead;
const configReadReleased = new Promise((resolve) => {
  releaseConfigRead = resolve;
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.166.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
  } else if (method === "account/read") {
    write({ id, result: { account: null, requiresOpenaiAuth: false } });
  } else if (method === "config/read") {
    configReadReleased.then(() => {
      log("config/read");
      write({ id, result: { config: { model_provider: "openrouter" }, origins: {} } });
    });
  } else if (method === "model/list") {
    log("model/list");
    write({ id, result: { data: [bundledModel], nextCursor: null } });
    releaseConfigRead();
  } else if (method === "skills/list") {
    write({ id, result: { data: [] } });
  } else if (method === "account/rateLimits/read") {
    write({ id, result: null });
  } else {
    write({ id, error: { code: -32601, message: "unsupported" } });
  }
});
`;

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
  default_service_tier: "flex",
  service_tiers: [
    { id: "priority", name: "Fast", description: "Lower latency responses." },
    { id: "flex", name: "Flex", description: "Lower-cost asynchronous routing." },
  ],
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
          const tiers = deepseek?.capabilities?.optionDescriptors?.find(
            (descriptor) => descriptor.id === "serviceTier",
          );
          assert.deepStrictEqual(
            tiers?.type === "select"
              ? tiers.options.map((option) => [option.id, option.isDefault ?? false])
              : [],
            [
              ["default", false],
              ["priority", false],
              ["flex", true],
            ],
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
        const freshCache = JSON.stringify({
          fetched_at: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 })),
          models: [cachedCustomModel],
        });
        yield* fs.writeFileString(path.join(dir, "models_cache.json"), freshCache);

        const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
        const provider = yield* checkCodexProviderStatus(
          decodeCodexSettings({ binaryPath, homePath: dir }),
          undefined,
          { ...environment, CODEX_TEST_CACHE: freshCache },
        );

        assert.deepStrictEqual(
          provider.models.map((model) => model.slug),
          ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash-1017"],
        );
      }).pipe(Effect.scoped),
    );

    it.effect("lists models without waiting for config/read", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-catalog-" });
        const binaryPath = path.join(dir, "codex");
        const logPath = path.join(dir, "requests.log");
        yield* fs.writeFileString(binaryPath, FAKE_CODEX_SLOW_CONFIG_APP_SERVER);
        yield* fs.chmod(binaryPath, 0o755);

        const { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: _ambient, ...environment } = process.env;
        const provider = yield* checkCodexProviderStatus(
          decodeCodexSettings({ binaryPath, homePath: dir }),
          undefined,
          { ...environment, CODEX_TEST_LOG: logPath },
        );

        assert.deepStrictEqual(
          provider.models.map((model) => model.slug),
          ["gpt-6.1-sol"],
        );
        const requests = (yield* fs.readFileString(logPath)).trim().split("\n");
        assert.isAbove(requests.indexOf("model/list"), -1);
        assert.isAbove(requests.indexOf("config/read"), -1);
        assert.isBelow(
          requests.indexOf("model/list"),
          requests.indexOf("config/read"),
          "model/list must start before config/read answers",
        );
      }).pipe(Effect.scoped),
    );
  },
);
