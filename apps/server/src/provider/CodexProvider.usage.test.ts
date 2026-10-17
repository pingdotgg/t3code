import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

/**
 * A stored ChatGPT login behind `requiresOpenaiAuth: true`, as the real CLI
 * reports for a custom provider that sets `requires_openai_auth = true`.
 * `account/rateLimits/read` leaves a marker file so a test can tell whether the
 * quota was fetched at all.
 */
const FAKE_CODEX_APP_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
fs.writeFileSync(
  path.join(process.env.CODEX_HOME, "models_cache.json"),
  JSON.stringify({ fetched_at: new Date().toISOString(), models: [] }),
);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    write({ id, result: { userAgent: "codex/0.162.0", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } });
  } else if (method === "account/read") {
    write({ id, result: { account: { type: "chatgpt", email: "test@example.com", planType: "pro" }, requiresOpenaiAuth: true } });
  } else if (method === "config/read") {
    if (process.env.FAKE_CODEX_CONFIG === undefined) {
      write({ id, error: { code: -32603, message: "config unreadable" } });
    } else {
      write({ id, result: { config: JSON.parse(process.env.FAKE_CODEX_CONFIG), origins: {} } });
    }
  } else if (method === "account/rateLimits/read") {
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "rate-limits-requested"), "");
    write({ id, result: { rateLimits: { primary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: 1789436313 } } } });
  } else if (method === "skills/list") {
    write({ id, result: { data: [] } });
  } else if (method === "model/list") {
    write({ id, result: { data: [], nextCursor: null } });
  } else {
    write({ id, error: { code: -32601, message: "unsupported" } });
  }
});
`;

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/** A `config` of `undefined` makes the fake CLI fail `config/read`. */
const usageFor = Effect.fn("usageFor")(function* (config: Record<string, unknown> | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-usage-" });
  const binaryPath = path.join(dir, "codex");
  yield* fs.writeFileString(binaryPath, FAKE_CODEX_APP_SERVER);
  yield* fs.chmod(binaryPath, 0o755);

  const provider = yield* checkCodexProviderStatus(
    decodeCodexSettings({ binaryPath, homePath: dir }),
    undefined,
    {
      ...process.env,
      ...(config === undefined ? {} : { FAKE_CODEX_CONFIG: JSON.stringify(config) }),
    },
  );
  return {
    usageLimits: provider.usageLimits,
    fetched: yield* fs.exists(path.join(dir, "rate-limits-requested")),
  };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("Codex native usage routing", (it) => {
  it.effect("reports the ChatGPT quota while requests go to OpenAI", () =>
    Effect.gen(function* () {
      for (const config of [
        {},
        { model_provider: null, model_providers: {}, openai_base_url: null },
        { openai_base_url: "https://api.openai.com/v1" },
        {
          model_provider: "mirror",
          model_providers: { mirror: { base_url: "https://chatgpt.com/backend-api/codex" } },
        },
        // A custom provider without a `base_url` falls back to OpenAI's endpoint.
        { model_provider: "plain", model_providers: { plain: { base_url: null } } },
      ]) {
        const { usageLimits, fetched } = yield* usageFor(config);
        assert.strictEqual(fetched, true);
        assert.strictEqual(usageLimits?.windows.length, 1);
        assert.strictEqual(usageLimits?.unavailable, undefined);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("skips the ChatGPT quota when requests go to a non-OpenAI base_url", () =>
    Effect.gen(function* () {
      for (const config of [
        {
          model_provider: "hub",
          model_providers: {
            hub: { base_url: "https://hub.example.com/v1", requires_openai_auth: true },
          },
        },
        { openai_base_url: "https://proxy.example.com/v1" },
        // Look-alike hosts are not OpenAI's.
        {
          model_provider: "hub",
          model_providers: { hub: { base_url: "https://evilopenai.com/v1" } },
        },
        { model_provider: "hub", model_providers: { hub: { base_url: "not a url" } } },
      ]) {
        const { usageLimits, fetched } = yield* usageFor(config);
        assert.strictEqual(fetched, false);
        assert.deepStrictEqual(usageLimits?.windows, []);
        assert.strictEqual(usageLimits?.unavailable?.reason, "unsupported");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("skips the ChatGPT quota when the routing config cannot be read", () =>
    Effect.gen(function* () {
      const { usageLimits, fetched } = yield* usageFor(undefined);
      assert.strictEqual(fetched, false);
      assert.deepStrictEqual(usageLimits?.windows, []);
      assert.strictEqual(usageLimits?.unavailable?.reason, "unsupported");
    }).pipe(Effect.scoped),
  );
});
