import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveUsageTranscriptSources } from "./usageTranscriptSources.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);

it.layer(NodeServices.layer)("resolveUsageTranscriptSources", (it) => {
  it.effect("reads custom homes from every explicit Claude and Codex instance", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-usage-sources-",
      });
      const claudeDefault = path.join(tempDir, "claude-default");
      const claudePersonal = path.join(tempDir, "claude-personal");
      const codexDefault = path.join(tempDir, "codex-default");
      const codexWork = path.join(tempDir, "codex-work");

      const settings = decodeSettings({
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", config: { homePath: claudeDefault } },
          claude_personal: { driver: "claudeAgent", config: { homePath: claudePersonal } },
          codex: { driver: "codex", config: { homePath: codexDefault } },
          codex_work: { driver: "codex", config: { homePath: codexWork } },
        },
      });

      const sources = yield* resolveUsageTranscriptSources(settings, {});

      assert.deepEqual(sources, [
        { provider: "claude", dir: path.join(claudeDefault, "projects") },
        { provider: "claude", dir: path.join(claudePersonal, "projects") },
        { provider: "codex", dir: path.join(codexDefault, "sessions") },
        { provider: "codex", dir: path.join(codexWork, "sessions") },
      ]);
    }),
  );

  it.effect("keeps legacy defaults for built-in slots absent from providerInstances", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeSettings({
        providerInstances: {
          claude_personal: {
            driver: "claudeAgent",
            config: { homePath: "/tmp/claude-personal" },
          },
        },
      });

      const sources = yield* resolveUsageTranscriptSources(settings, {});

      assert.equal(sources.filter((source) => source.provider === "claude").length, 2);
      assert.ok(
        sources.some(
          (source) =>
            source.provider === "codex" &&
            source.dir === path.join(NodeOS.homedir(), ".codex", "sessions"),
        ),
      );
    }),
  );

  it.effect("honors a per-instance CLAUDE_CONFIG_DIR when homePath is empty", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeSettings({
        providerInstances: {
          claudeAgent: {
            driver: "claudeAgent",
            config: {},
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/tmp/claude-from-environment" }],
          },
          codex: { driver: "codex", config: {} },
        },
      });

      const sources = yield* resolveUsageTranscriptSources(settings, {});

      assert.ok(
        sources.some(
          (source) =>
            source.provider === "claude" &&
            source.dir === path.resolve("/tmp/claude-from-environment/projects"),
        ),
      );
    }),
  );

  it.effect("deduplicates instances that share a transcript directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const settings = decodeSettings({
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", config: { homePath: "/tmp/shared-claude" } },
          claude_work: { driver: "claudeAgent", config: { homePath: "/tmp/shared-claude" } },
          codex: { driver: "codex", config: {} },
        },
      });

      const sources = yield* resolveUsageTranscriptSources(settings, {});

      assert.deepEqual(
        sources.filter((source) => source.provider === "claude"),
        [{ provider: "claude", dir: path.resolve("/tmp/shared-claude/projects") }],
      );
    }),
  );

  it.effect("preserves the nested legacy Claude transcript layout when it exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-usage-sources-",
      });
      const nestedProjects = path.join(tempDir, ".claude", "projects");
      yield* fileSystem.makeDirectory(nestedProjects, { recursive: true });
      const settings = decodeSettings({
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", config: { homePath: tempDir } },
          codex: { driver: "codex", config: {} },
        },
      });

      const sources = yield* resolveUsageTranscriptSources(settings, {});

      assert.ok(
        sources.some((source) => source.provider === "claude" && source.dir === nestedProjects),
      );
    }),
  );
});
