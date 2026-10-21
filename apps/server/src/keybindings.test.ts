import {
  KeybindingCommand,
  KeybindingRule,
  KeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import { KeybindingsConfigError, MAX_KEYBINDINGS_COUNT } from "@t3tools/contracts";

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const encodeKeybindingsConfigJson = Schema.encodeEffect(KeybindingsConfigJson);
const decodeKeybindingsConfigJson = Schema.decodeUnknownEffect(KeybindingsConfigJson);
const layerKeybindings = () => {
  return Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* encodeKeybindingsConfigJson(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* decodeKeybindingsConfigJson(rawConfig);
  });

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("parses shortcuts including plus key", () =>
    Effect.sync(() => {
      assert.deepEqual(Keybindings.parseKeybindingShortcut("mod+j"), {
        key: "j",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(Keybindings.parseKeybindingShortcut("mod++"), {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("compiles valid rule with parsed when AST", () =>
    Effect.sync(() => {
      const compiled = Keybindings.compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalOpen && !terminalFocus",
      });

      assert.deepEqual(compiled, {
        command: "terminal.split",
        shortcut: {
          key: "d",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: {
          type: "and",
          left: { type: "identifier", name: "terminalOpen" },
          right: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      });
    }),
  );

  it.effect("rejects invalid rules", () =>
    Effect.sync(() => {
      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+shift+d+o",
          command: "terminal.new",
        }),
      );

      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: "terminalFocus && (",
        }),
      );

      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: `${"!".repeat(300)}terminalFocus`,
        }),
      );
    }),
  );

  it.effect("bootstraps default keybindings when config file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      assert.isFalse(yield* fs.exists(keybindingsConfigPath));

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, Keybindings.DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        Keybindings.compileResolvedKeybindingsConfig(Keybindings.DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("ignores invalid entries in runtime and reports them as issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+d+o", command: "terminal.new" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
        {
          kind: "keybindings.invalid-entry",
          index: 2,
          message: configState.issues[1]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect(
    "upserts missing default keybindings on startup without overriding existing command rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+shift+y", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
          { key: "mod+shift+b", command: "script.custom-panel.run" },
          {
            key: "mod+shift+b",
            command: "script.custom-composer.run",
            when: "composerFocus",
          },
        ]);

        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const byCommand = new Map(persisted.map((entry) => [entry.command, entry]));

        const persistedToggle = byCommand.get("terminal.toggle");
        assert.isNotNull(persistedToggle);
        assert.equal(persistedToggle?.key, "mod+shift+y");
        assert.isFalse(
          persisted.some((entry) => entry.command === "terminal.toggle" && entry.key === "mod+j"),
        );

        for (const defaultRule of Keybindings.DEFAULT_KEYBINDINGS) {
          assert.isTrue(byCommand.has(defaultRule.command), `expected ${defaultRule.command}`);
        }
        assert.isTrue(byCommand.has("script.run-tests.run"));

        const configState = yield* keybindings.loadConfigState;
        assert.deepEqual(
          configState.keybindings
            .filter((entry) => entry.shortcut.key === "b" && entry.shortcut.shiftKey)
            .map((entry) => entry.command),
          ["threadPanel.toggle", "script.custom-panel.run", "script.custom-composer.run"],
        );
      }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("adds a late default to an existing command once", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const when = "composerFocus && draftThreadRoute";
      const existing = { key: "mod+alt+enter", command: "composer.sendBackground", when } as const;
      const backgroundRules = Effect.map(readKeybindingsConfig(keybindingsConfigPath), (rules) =>
        rules.filter((entry) => entry.command === "composer.sendBackground"),
      );
      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing]);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepStrictEqual(yield* backgroundRules, [
        { key: "mod+enter", command: "composer.sendBackground", when },
        existing,
      ]);

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.deepStrictEqual(yield* backgroundRules, [existing]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("leaves a customized command without the late default", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const custom = {
        key: "alt+b",
        command: "composer.sendBackground",
        when: "composerFocus && draftThreadRoute",
      } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [custom]);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepStrictEqual(
        persisted.filter((entry) => entry.command === "composer.sendBackground"),
        [custom],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  for (const oldWhen of ["isDesktop", "!modelPickerOpen && isDesktop"]) {
    it.effect(
      `updates persisted thread defaults (${oldWhen}) once and respects later removals`,
      () =>
        Effect.gen(function* () {
          const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
          const keybindings = yield* Keybindings.Keybindings;
          const oldRules = THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
            key: `mod+${index + 1}`,
            command,
            when: oldWhen,
          }));
          yield* writeKeybindingsConfig(keybindingsConfigPath, oldRules);
          yield* keybindings.syncDefaultKeybindingsOnStartup;
          const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
          for (const existing of oldRules) {
            assert.deepStrictEqual(
              persisted.filter((entry) => entry.command === existing.command),
              [
                {
                  ...existing,
                  key: existing.key.replace("mod+", "mod+alt+"),
                  when: "isDesktop && !isMac",
                },
                { ...existing, when: "!modelPickerOpen && isDesktop && isMac" },
              ],
            );
          }

          const withoutAlternates = persisted.filter(
            (entry) =>
              !entry.command.startsWith("thread.jump.") ||
              entry.when === "!modelPickerOpen && isDesktop && isMac",
          );
          yield* writeKeybindingsConfig(keybindingsConfigPath, withoutAlternates);
          yield* keybindings.syncDefaultKeybindingsOnStartup;
          assert.deepStrictEqual(
            yield* readKeybindingsConfig(keybindingsConfigPath),
            withoutAlternates,
          );
        }).pipe(Effect.provide(layerKeybindings())),
    );
  }

  it.effect("preserves customized and conflicting persisted thread shortcuts", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const existing = [
        { key: "mod+shift+1", command: "thread.jump.1", when: "isDesktop" },
        { key: "mod+2", command: "thread.jump.2", when: "isDesktop && !terminalFocus" },
        { key: "mod+3", command: "thread.jump.3", when: "isDesktop" },
        { key: "mod+alt+3", command: "script.custom.run", when: "isDesktop && !isMac" },
      ] as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, existing);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      for (const entry of existing) {
        assert.deepStrictEqual(
          persisted.filter((rule) => rule.command === entry.command),
          [entry],
        );
      }
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps an old thread default unchanged while its replacement cannot fit", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const existing = { key: "mod+1", command: "thread.jump.1", when: "isDesktop" } as const;
      const fillers = Array.from({ length: MAX_KEYBINDINGS_COUNT - 1 }, (_, index) => ({
        key: "mod+alt+f1",
        command: `script.filler-${index}.run` as const,
      }));
      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing, ...fillers]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const fullConfig = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepStrictEqual(
        fullConfig.filter((entry) => entry.command === existing.command),
        [existing],
      );

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const migrated = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepStrictEqual(
        migrated.filter((entry) => entry.command === existing.command),
        [
          { ...existing, key: "mod+alt+1", when: "isDesktop && !isMac" },
          { ...existing, when: "!modelPickerOpen && isDesktop && isMac" },
        ],
      );
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("keeps a late default pending while the config is full", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      const when = "composerFocus && draftThreadRoute";
      const existing = { key: "mod+alt+enter", command: "composer.sendBackground", when } as const;
      const fillers = Array.from({ length: MAX_KEYBINDINGS_COUNT - 1 }, (_, index) => ({
        key: "mod+alt+f1",
        command: `script.filler-${index}.run` as const,
      }));
      const hasModEnter = Effect.map(readKeybindingsConfig(keybindingsConfigPath), (rules) =>
        rules.some(
          (entry) => entry.command === "composer.sendBackground" && entry.key === "mod+enter",
        ),
      );

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing, ...fillers]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.isFalse(yield* hasModEnter);

      yield* writeKeybindingsConfig(keybindingsConfigPath, [existing]);
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      assert.isTrue(yield* hasModEnter);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("skips conflicting default keybindings on startup and logs a detailed warning", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "script.custom-action.run" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "terminal.toggle"));
      assert.isTrue(persisted.some((entry) => entry.command === "script.custom-action.run"));

      assert.isTrue(
        messages.some((message) =>
          message.includes("skipping default keybinding due to shortcut conflict"),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerKeybindings(), Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("appends additional custom keybindings for the same command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("replaces only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("replacing with a rule that already exists elsewhere does not duplicate it", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+alt+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("removes only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.removeKeybindingRule({
          key: "mod+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "expected JSON array");

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("retries a failed config read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fileSystem.makeDirectory(keybindingsConfigPath, { recursive: true });

      const keybindings = yield* Keybindings.Keybindings;
      const failed = yield* toDetailResult(keybindings.loadConfigState);
      assertFailure(failed, "failed to read keybindings config");

      yield* fileSystem.remove(keybindingsConfigPath, { recursive: true });
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const configState = yield* keybindings.loadConfigState;
      assert.deepEqual(configState.issues, []);
      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(layerKeybindings())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* Effect.forEach(
          commands,
          (command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(layerKeybindings())),
  );
});
