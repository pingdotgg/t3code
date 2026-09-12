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
      // The real file carries dozens of unrelated keys around the cache, and
      // names older models by dated API id where the catalog uses the bare
      // slug.
      yield* writeClaudeConfig(
        configDir,
        `{
          "numStartups": 12,
          "oauthAccount": { "emailAddress": "dev@example.com" },
          "modelAccessCache": [
            { "apiName": "claude-fable-5", "entitled": false },
            { "apiName": "claude-fable-5-1", "entitled": false },
            { "apiName": "claude-haiku-4-5-20251001", "entitled": false },
            { "apiName": "claude-opus-4-5-20251101", "entitled": true },
            { "apiName": "claude-opus-5", "entitled": true },
            { "apiName": "claude-sonnet-5", "entitled": true }
          ]
        }`,
      );

      const restricted = yield* readClaudeRestrictedModels({ CLAUDE_CONFIG_DIR: configDir });

      assert.deepEqual([...restricted], ["claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5"]);
    }),
  );

  it.effect("reads ~/.claude.json of the home the CLI is spawned with", () =>
    Effect.gen(function* () {
      const home = yield* makeConfigDir("home");
      yield* writeClaudeConfig(
        home,
        `{ "modelAccessCache": [{ "apiName": "claude-fable-5", "entitled": false }] }`,
      );

      // An instance environment may override HOME; the reader has to follow
      // it to the same file the child reads rather than the server's own.
      const restricted = yield* readClaudeRestrictedModels({ HOME: home });

      assert.deepEqual([...restricted], ["claude-fable-5"]);
    }),
  );

  it.effect("restricts nothing for a relative config dir or home", () =>
    Effect.gen(function* () {
      // The CLI resolves a relative CLAUDE_CONFIG_DIR or HOME against each
      // session's own working directory, so no single file speaks for the
      // environment. The file must not even be consulted: this filesystem
      // would answer every read with a restriction.
      const reads: Array<string> = [];
      const restrictiveFileSystem = FileSystem.layerNoop({
        readFileString: (filePath) =>
          Effect.sync(() => {
            reads.push(filePath);
            return `{ "modelAccessCache": [{ "apiName": "claude-fable-5", "entitled": false }] }`;
          }),
      });

      for (const environment of [{ CLAUDE_CONFIG_DIR: "./claude" }, { HOME: "home" }]) {
        const restricted = yield* readClaudeRestrictedModels(environment).pipe(
          Effect.provide(restrictiveFileSystem),
        );
        assert.deepEqual([...restricted], []);
      }
      assert.deepEqual(reads, []);
    }),
  );

  it.effect("restricts nothing when the config is missing or malformed", () =>
    Effect.gen(function* () {
      const absent = yield* makeConfigDir("absent-home");
      assert.deepEqual([...(yield* readClaudeRestrictedModels({ CLAUDE_CONFIG_DIR: absent }))], []);

      const brokenJson = yield* makeConfigDir("broken-json");
      yield* writeClaudeConfig(brokenJson, "{ not json");
      assert.deepEqual(
        [...(yield* readClaudeRestrictedModels({ CLAUDE_CONFIG_DIR: brokenJson }))],
        [],
      );

      const brokenCache = yield* makeConfigDir("broken-cache");
      yield* writeClaudeConfig(brokenCache, `{ "modelAccessCache": { "claude-fable-5": false } }`);
      assert.deepEqual(
        [...(yield* readClaudeRestrictedModels({ CLAUDE_CONFIG_DIR: brokenCache }))],
        [],
      );
    }),
  );

  it.effect("ignores entries that carry no usable model id or verdict", () =>
    Effect.gen(function* () {
      const configDir = yield* makeConfigDir("partial-home");
      yield* writeClaudeConfig(
        configDir,
        `{
          "modelAccessCache": [
            null,
            "claude-fable-5",
            { "entitled": false },
            { "apiName": "   ", "entitled": false },
            { "apiName": "claude-opus-5" },
            { "apiName": "claude-sonnet-4-6", "entitled": false }
          ]
        }`,
      );

      const restricted = yield* readClaudeRestrictedModels({ CLAUDE_CONFIG_DIR: configDir });

      // Only an explicit `false` restricts: an absent verdict is unknown, not
      // disallowed, and one odd entry does not cost the others.
      assert.deepEqual([...restricted], ["claude-sonnet-4-6"]);
    }),
  );
});
