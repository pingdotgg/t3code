import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { readClaudeRestrictedModels } from "./claudeModelAccess.ts";

const readAccountConfig = (contents: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const accountConfigPath = path.join(yield* fs.makeTempDirectoryScoped(), ".claude.json");
    if (contents !== undefined) yield* fs.writeFileString(accountConfigPath, contents);
    return [...(yield* readClaudeRestrictedModels(accountConfigPath))];
  });

effectIt.layer(NodeServices.layer)("readClaudeRestrictedModels", (it) => {
  it.effect("names only the models the cache explicitly denies, as catalog slugs", () =>
    Effect.gen(function* () {
      const restricted = yield* readAccountConfig(
        JSON.stringify({
          modelAccessCache: [
            { apiName: "claude-fable-5-1", entitled: false },
            { apiName: "claude-opus-5-5", entitled: true },
            { apiName: "claude-haiku-4-5-20251001", entitled: false },
            { apiName: "Claude-Sonnet-5[1m]", entitled: false },
            { apiName: "claude-opus-5", entitled: "false" },
            { entitled: false },
            null,
          ],
        }),
      );
      expect(restricted).toEqual(["claude-fable-5-1", "claude-haiku-4-5", "claude-sonnet-5"]);
    }),
  );

  it.effect.each([
    { case: "a missing file", contents: undefined },
    { case: "malformed JSON", contents: "{" },
    { case: "a config without a cache", contents: '{"oauthAccount":{}}' },
    {
      case: "a cache that is not a list",
      contents: '{"modelAccessCache":{"claude-fable-5-1":false}}',
    },
  ])("turns off nothing for $case", ({ contents }) =>
    Effect.gen(function* () {
      expect(yield* readAccountConfig(contents)).toEqual([]);
    }),
  );
});
