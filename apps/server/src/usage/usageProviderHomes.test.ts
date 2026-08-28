import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveUsageProviderHomes } from "./usageProviderHomes.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

it.layer(NodeServices.layer)("usageProviderHomes", (it) => {
  describe("resolveUsageProviderHomes", () => {
    it.effect("scans every configured Claude instance home, not just the default", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({
          providerInstances: {
            claude_max: { driver: "claudeAgent", config: { homePath: "~/.claude-max" } },
            claude_pro: {
              driver: "claudeAgent",
              environment: [{ name: "CLAUDE_CONFIG_DIR", value: "~/.claude-pro" }],
            },
            codex_work: { driver: "codex", config: { homePath: "~/.codex-work" } },
          },
        });

        const homes = yield* resolveUsageProviderHomes(settings, {});

        expect(homes.claudeHomePaths).toEqual([
          path.resolve(NodeOS.homedir(), ".claude-max"),
          path.resolve(NodeOS.homedir(), ".claude-pro"),
          // Synthesized legacy `claudeAgent` instance: the default home.
          path.resolve(NodeOS.homedir()),
        ]);
        expect(homes.codexSessionDirs).toEqual([
          path.join(path.resolve(NodeOS.homedir(), ".codex-work"), "sessions"),
          path.join(NodeOS.homedir(), ".codex", "sessions"),
        ]);
        expect(homes.grokSessionsDir).toBe(path.join(NodeOS.homedir(), ".grok", "sessions"));
      }),
    );

    it.effect("collapses instances that resolve to the same home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({
          providerInstances: {
            claude_alias: { driver: "claudeAgent", config: { homePath: "" } },
          },
        });

        const homes = yield* resolveUsageProviderHomes(settings, {});

        // `claude_alias` and the synthesized legacy instance share the
        // default home; scanning it twice would double count every record.
        expect(homes.claudeHomePaths).toEqual([path.resolve(NodeOS.homedir())]);
      }),
    );

    it.effect("skips instances whose config fails to decode", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({
          providerInstances: {
            claude_bad: { driver: "claudeAgent", config: { homePath: 42 } },
          },
        });

        const homes = yield* resolveUsageProviderHomes(settings, {});

        expect(homes.claudeHomePaths).toEqual([path.resolve(NodeOS.homedir())]);
      }),
    );

    it.effect("ignores the server's ambient CLAUDE_CONFIG_DIR", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({});

        // What usage scans must be determined by settings alone, not by the
        // environment this particular server process was launched with.
        const homes = yield* resolveUsageProviderHomes(settings, {
          CLAUDE_CONFIG_DIR: "~/.claude-ambient",
        });

        expect(homes.claudeHomePaths).toEqual([path.resolve(NodeOS.homedir())]);
      }),
    );

    it.effect("still resolves legacy single-instance homes from providers settings", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({
          providers: {
            claudeAgent: { homePath: "~/.claude-legacy" },
            codex: { homePath: "~/.codex-legacy" },
          },
        });

        const homes = yield* resolveUsageProviderHomes(settings, { GROK_HOME: "~/.grok-custom" });

        expect(homes.claudeHomePaths).toEqual([path.resolve(NodeOS.homedir(), ".claude-legacy")]);
        expect(homes.codexSessionDirs).toEqual([
          path.join(path.resolve(NodeOS.homedir(), ".codex-legacy"), "sessions"),
        ]);
        expect(homes.grokSessionsDir).toBe(
          path.join(path.resolve(NodeOS.homedir(), ".grok-custom"), "sessions"),
        );
      }),
    );
  });
});
