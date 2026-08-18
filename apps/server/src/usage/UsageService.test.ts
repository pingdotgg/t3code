import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";

import { resolveDevinTranscriptDirs } from "./UsageService.ts";

it.layer(NodeServices.layer)("UsageService", (it) => {
  describe("resolveDevinTranscriptDirs", () => {
    it.effect("includes unique Devin instance homes alongside the default home", () => {
      const settings = Schema.decodeSync(ServerSettingsSchema)({
        providerInstances: {
          devin_default: {
            driver: "devin",
            config: { homePath: "" },
          },
          devin_work: {
            driver: "devin",
            config: { homePath: "~/.devin-work" },
          },
          devin_work_duplicate: {
            driver: "devin",
            config: { homePath: "~/.devin-work" },
          },
          codex_work: {
            driver: "codex",
            config: { homePath: "~/.codex-work" },
          },
        },
      });

      return Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(yield* resolveDevinTranscriptDirs(settings)).toEqual([
          path.resolve(NodeOS.homedir(), ".devin"),
          path.resolve(NodeOS.homedir(), ".devin-work"),
        ]);
      });
    });
  });
});
