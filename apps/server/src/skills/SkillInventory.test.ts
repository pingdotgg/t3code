import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { discoverGlobalSkillInventory, readSkillInstallations } from "./SkillInventory.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const writeSkill = Effect.fn("SkillInventoryTest.writeSkill")(function* (
  root: string,
  directoryName: string,
  description: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, "skills", directoryName);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, "SKILL.md"),
    `---\nname: ${directoryName}\ndescription: ${description}\n---\n`,
  );
});

it.layer(NodeServices.layer)("discoverGlobalSkillInventory", (it) => {
  it.effect("omits skills that become unreadable during inventory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-skill-inventory-unreadable-",
      });
      const installations = yield* readSkillInstallations({
        instanceId: "codex",
        instance: {
          driver: ProviderDriverKind.make("codex"),
          config: decodeCodexSettings({}),
        },
        fallbackDisplayName: "Codex",
        skills: [
          {
            name: "removed",
            path: path.join(tempDirectory, "removed", "SKILL.md"),
            enabled: true,
            scope: "user",
          },
        ],
      });
      assert.deepEqual(installations, []);
    }),
  );

  it.effect("discovers global skills for configured Codex and Claude instances", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-skill-inventory-",
      });
      const codexHome = path.join(tempDirectory, "codex");
      const claudeHome = path.join(tempDirectory, "claude");
      yield* writeSkill(codexHome, "review", "Review with Codex.");
      yield* writeSkill(claudeHome, "deploy", "Deploy with Claude.");

      const inventory = yield* discoverGlobalSkillInventory().pipe(
        Effect.provide(
          ServerSettings.layerTest({
            providers: {
              codex: decodeCodexSettings({ homePath: path.join(tempDirectory, "empty-codex") }),
              claudeAgent: decodeClaudeSettings({
                homePath: path.join(tempDirectory, "empty-claude"),
              }),
            },
            providerInstances: {
              [ProviderInstanceId.make("codex_work")]: {
                driver: ProviderDriverKind.make("codex"),
                displayName: "Codex Work",
                config: decodeCodexSettings({ homePath: codexHome }),
              },
              [ProviderInstanceId.make("claude_personal")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                displayName: "Claude Personal",
                config: decodeClaudeSettings({ homePath: claudeHome }),
              },
            },
          }),
        ),
      );

      assert.deepEqual(
        inventory.installations.map((skill) => ({
          harness: skill.harness,
          harnessDisplayName: skill.harnessDisplayName,
          name: skill.name,
          directoryPath: skill.directoryPath,
          hasContent: skill.content.includes(`#`) || skill.content.includes("description:"),
        })),
        [
          {
            harness: "claudeAgent",
            harnessDisplayName: "Claude Personal",
            name: "deploy",
            directoryPath: path.join(claudeHome, "skills", "deploy"),
            hasContent: true,
          },
          {
            harness: "codex",
            harnessDisplayName: "Codex Work",
            name: "review",
            directoryPath: path.join(codexHome, "skills", "review"),
            hasContent: true,
          },
        ],
      );
    }),
  );

  it.effect("respects provider enablement and instance environment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-skill-inventory-environment-",
      });
      const codexHome = path.join(tempDirectory, "codex-env");
      const claudeHome = path.join(tempDirectory, "claude-env");
      const disabledCodexHome = path.join(tempDirectory, "codex-disabled");
      const disabledClaudeHome = path.join(tempDirectory, "claude-disabled");
      yield* writeSkill(codexHome, "codex-env-skill", "Loaded from CODEX_HOME.");
      yield* writeSkill(claudeHome, "claude-env-skill", "Loaded from CLAUDE_CONFIG_DIR.");
      yield* writeSkill(disabledCodexHome, "disabled-codex", "Must not appear.");
      yield* writeSkill(disabledClaudeHome, "disabled-claude", "Must not appear.");

      const inventory = yield* discoverGlobalSkillInventory().pipe(
        Effect.provide(
          ServerSettings.layerTest({
            providers: {
              codex: decodeCodexSettings({ homePath: path.join(tempDirectory, "legacy-codex") }),
              claudeAgent: decodeClaudeSettings({
                homePath: path.join(tempDirectory, "legacy-claude"),
              }),
            },
            providerInstances: {
              [ProviderInstanceId.make("codex_env")]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
                config: decodeCodexSettings({}),
              },
              [ProviderInstanceId.make("claude_env")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeHome, sensitive: false }],
                config: decodeClaudeSettings({}),
              },
              [ProviderInstanceId.make("codex_disabled")]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: false,
                config: decodeCodexSettings({ homePath: disabledCodexHome }),
              },
              [ProviderInstanceId.make("claude_disabled")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: decodeClaudeSettings({ enabled: false, homePath: disabledClaudeHome }),
              },
            },
          }),
        ),
      );

      assert.deepEqual(inventory.installations.map((skill) => skill.name).sort(), [
        "claude-env-skill",
        "codex-env-skill",
      ]);
    }),
  );

  it.effect("ignores unsupported provider instances", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-skill-inventory-empty-",
      });
      const inventory = yield* discoverGlobalSkillInventory().pipe(
        Effect.provide(
          ServerSettings.layerTest({
            providers: {
              codex: decodeCodexSettings({ homePath: path.join(tempDirectory, "codex") }),
              claudeAgent: decodeClaudeSettings({
                homePath: path.join(tempDirectory, "claude"),
              }),
            },
            providerInstances: {
              [ProviderInstanceId.make("opencode")]: {
                driver: ProviderDriverKind.make("opencode"),
                config: {},
              },
            },
          }),
        ),
      );
      assert.deepEqual(inventory.installations, []);
    }),
  );
});
