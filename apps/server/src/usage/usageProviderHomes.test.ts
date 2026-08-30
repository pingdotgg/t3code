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
              environment: [
                { name: "CLAUDE_CONFIG_DIR", value: path.join(NodeOS.homedir(), ".claude-pro") },
              ],
            },
            codex_work: { driver: "codex", config: { homePath: "~/.codex-work" } },
            codex_env: {
              driver: "codex",
              environment: [
                { name: "CODEX_HOME", value: path.join(NodeOS.homedir(), ".codex-env") },
              ],
            },
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
          path.join(NodeOS.homedir(), ".codex-env", "sessions"),
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

    it.effect("ignores non-absolute environment homes, which the CLI gets verbatim", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({
          providerInstances: {
            // Env vars are never shell-expanded, so a tilde or relative value
            // depends on each workspace's cwd and has no single scan dir.
            claude_tilde: {
              driver: "claudeAgent",
              environment: [{ name: "CLAUDE_CONFIG_DIR", value: "~/.claude-tilde" }],
            },
            codex_relative: {
              driver: "codex",
              environment: [{ name: "CODEX_HOME", value: "codex-home" }],
            },
          },
        });

        const homes = yield* resolveUsageProviderHomes(settings, {});

        expect(homes.claudeHomePaths).toEqual([path.resolve(NodeOS.homedir())]);
        expect(homes.codexSessionDirs).toEqual([path.join(NodeOS.homedir(), ".codex", "sessions")]);
      }),
    );

    it.effect("prefers the shadow-overlay shared home over an inert instance CODEX_HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({
          providerInstances: {
            // With a shadow overlay the runtime overrides CODEX_HOME, and
            // the shadow's sessions symlink back to the shared home.
            codex_shadow: {
              driver: "codex",
              config: { shadowHomePath: "~/.codex-shadow" },
              environment: [
                { name: "CODEX_HOME", value: path.join(NodeOS.homedir(), ".codex-env") },
              ],
            },
          },
        });

        const homes = yield* resolveUsageProviderHomes(settings, {});

        expect(homes.codexSessionDirs).toEqual([path.join(NodeOS.homedir(), ".codex", "sessions")]);
      }),
    );

    it.effect("inherits absolute provider homes from the server environment", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({});
        const claudeHome = path.join(NodeOS.homedir(), ".claude-ambient");
        const codexHome = path.join(NodeOS.homedir(), ".codex-ambient");

        const homes = yield* resolveUsageProviderHomes(settings, {
          CLAUDE_CONFIG_DIR: claudeHome,
          CODEX_HOME: codexHome,
        });

        expect(homes.claudeHomePaths).toEqual([claudeHome]);
        expect(homes.codexSessionDirs).toEqual([path.join(codexHome, "sessions")]);
      }),
    );

    it.effect("lets instance environment homes override the server environment", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHome = path.join(NodeOS.homedir(), ".claude-instance");
        const codexHome = path.join(NodeOS.homedir(), ".codex-instance");
        const settings = decodeSettings({
          providerInstances: {
            claudeAgent: {
              driver: "claudeAgent",
              environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeHome }],
            },
            codex: {
              driver: "codex",
              environment: [{ name: "CODEX_HOME", value: codexHome }],
            },
          },
        });

        const homes = yield* resolveUsageProviderHomes(settings, {
          CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), ".claude-ambient"),
          CODEX_HOME: path.join(NodeOS.homedir(), ".codex-ambient"),
        });

        expect(homes.claudeHomePaths).toEqual([claudeHome]);
        expect(homes.codexSessionDirs).toEqual([path.join(codexHome, "sessions")]);
      }),
    );

    it.effect("lets blank instance variables suppress inherited provider homes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const settings = decodeSettings({
          providerInstances: {
            claudeAgent: {
              driver: "claudeAgent",
              environment: [{ name: "CLAUDE_CONFIG_DIR", value: "" }],
            },
            codex: {
              driver: "codex",
              environment: [{ name: "CODEX_HOME", value: "" }],
            },
          },
        });

        const homes = yield* resolveUsageProviderHomes(settings, {
          CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), ".claude-ambient"),
          CODEX_HOME: path.join(NodeOS.homedir(), ".codex-ambient"),
        });

        expect(homes.claudeHomePaths).toEqual([path.resolve(NodeOS.homedir())]);
        expect(homes.codexSessionDirs).toEqual([path.join(NodeOS.homedir(), ".codex", "sessions")]);
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

        const homes = yield* resolveUsageProviderHomes(settings, {
          CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), ".claude-ambient"),
          CODEX_HOME: path.join(NodeOS.homedir(), ".codex-ambient"),
          GROK_HOME: "~/.grok-custom",
        });

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
