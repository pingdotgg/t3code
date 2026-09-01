import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readClaudeRestrictedModels } from "./ClaudeEntitlements.ts";

const writeClaudeConfig = Effect.fn(function* (configDir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(configDir, { recursive: true });
  yield* fs.writeFileString(path.join(configDir, ".claude.json"), contents);
});

const makeConfigDir = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-entitlements-" });
  return path.join(tempDir, name);
});

it.layer(NodeServices.layer)("readClaudeRestrictedModels", (it) => {
  it.effect("returns only the models the organization has disallowed", () =>
    Effect.gen(function* () {
      const configDir = yield* makeConfigDir("claude-home");
      yield* writeClaudeConfig(
        configDir,
        JSON.stringify({
          modelAccessCache: [
            { apiName: "claude-fable-5", entitled: false },
            { apiName: "claude-opus-5", entitled: true },
            { apiName: "claude-sonnet-5", entitled: true },
            { apiName: "claude-opus-4-8", entitled: true },
          ],
        }),
      );

      const restricted = yield* readClaudeRestrictedModels({ homePath: configDir });

      assert.deepEqual([...restricted], ["claude-fable-5"]);
    }),
  );

  it.effect("reads the config beside a CLAUDE_CONFIG_DIR from the environment", () =>
    Effect.gen(function* () {
      const configDir = yield* makeConfigDir("ambient-home");
      yield* writeClaudeConfig(
        configDir,
        JSON.stringify({ modelAccessCache: [{ apiName: "claude-fable-5", entitled: false }] }),
      );

      const restricted = yield* readClaudeRestrictedModels(
        { homePath: "" },
        { CLAUDE_CONFIG_DIR: configDir },
      );

      assert.deepEqual([...restricted], ["claude-fable-5"]);
    }),
  );

  it.effect("restricts nothing when the config is missing", () =>
    Effect.gen(function* () {
      const configDir = yield* makeConfigDir("absent-home");

      const restricted = yield* readClaudeRestrictedModels({ homePath: configDir });

      assert.deepEqual([...restricted], []);
    }),
  );

  it.effect("restricts nothing when the config or its cache is malformed", () =>
    Effect.gen(function* () {
      const brokenJson = yield* makeConfigDir("broken-json");
      yield* writeClaudeConfig(brokenJson, "{ not json");
      assert.deepEqual([...(yield* readClaudeRestrictedModels({ homePath: brokenJson }))], []);

      const brokenCache = yield* makeConfigDir("broken-cache");
      yield* writeClaudeConfig(
        brokenCache,
        JSON.stringify({ modelAccessCache: { "claude-fable-5": false } }),
      );
      assert.deepEqual([...(yield* readClaudeRestrictedModels({ homePath: brokenCache }))], []);
    }),
  );

  it.effect("ignores entries that carry no usable model id or verdict", () =>
    Effect.gen(function* () {
      const configDir = yield* makeConfigDir("partial-home");
      yield* writeClaudeConfig(
        configDir,
        JSON.stringify({
          modelAccessCache: [
            null,
            "claude-fable-5",
            { entitled: false },
            { apiName: "   ", entitled: false },
            // Only an explicit `false` restricts: an absent verdict is unknown,
            // not disallowed.
            { apiName: "claude-opus-5" },
            { apiName: "claude-sonnet-4-6", entitled: false },
          ],
        }),
      );

      const restricted = yield* readClaudeRestrictedModels({ homePath: configDir });

      assert.deepEqual([...restricted], ["claude-sonnet-4-6"]);
    }),
  );
});
