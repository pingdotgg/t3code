import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveTranscriptDirsForSettings } from "./UsageService.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);

it.layer(NodeServices.layer)("resolveTranscriptDirsForSettings", (it) => {
  describe("provider instances", () => {
    it.effect("includes custom Codex homes and deduplicates legacy homes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const legacyHome = path.resolve("/tmp/t3-legacy-codex-home");
        const instanceHome = path.resolve("/tmp/t3-instance-codex-home");
        const settings = decodeSettings({
          providers: { codex: { homePath: legacyHome } },
          providerInstances: {
            codex_work: {
              driver: "codex",
              enabled: true,
              config: { homePath: instanceHome },
            },
            codex_legacy_duplicate: {
              driver: "codex",
              enabled: true,
              config: { homePath: legacyHome },
            },
          },
        });

        const dirs = yield* resolveTranscriptDirsForSettings(settings);

        expect(dirs.filter(({ provider }) => provider === "codex")).toEqual([
          { provider: "codex", dir: path.join(legacyHome, "sessions") },
          { provider: "codex", dir: path.join(instanceHome, "sessions") },
        ]);
      }),
    );
  });
});
