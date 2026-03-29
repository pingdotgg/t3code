import { Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  KeybindingsConfig,
  KeybindingRule,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "./keybindings";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const decodeResolvedRule = Schema.decodeUnknownEffect(ResolvedKeybindingRule as never);

it.effect("parses keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+j",
      command: "terminal.toggle",
    });
    assert.strictEqual(parsed.command, "terminal.toggle");

    const parsedClose = yield* decode(KeybindingRule, {
      key: "mod+w",
      command: "terminal.close",
    });
    assert.strictEqual(parsedClose.command, "terminal.close");

    const parsedDiffToggle = yield* decode(KeybindingRule, {
      key: "mod+d",
      command: "diff.toggle",
    });
    assert.strictEqual(parsedDiffToggle.command, "diff.toggle");

    const parsedLocal = yield* decode(KeybindingRule, {
      key: "mod+shift+n",
      command: "chat.newLocal",
    });
    assert.strictEqual(parsedLocal.command, "chat.newLocal");

    const parsedThreadPrevious = yield* decode(KeybindingRule, {
      key: "mod+shift+[",
      command: "thread.previous",
    });
    assert.strictEqual(parsedThreadPrevious.command, "thread.previous");
  }),
);

it.effect("rejects invalid command values", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(KeybindingRule, {
        key: "mod+j",
        command: "script.Test.run",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts dynamic script run commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+r",
      command: "script.setup.run",
    });
    assert.strictEqual(parsed.command, "script.setup.run");
  }),
);

it.effect("parses keybindings array payload", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingsConfig, [
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
    ]);
    assert.lengthOf(parsed, 2);
  }),
);

it.effect("parses resolved keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingRule, {
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
    assert.strictEqual(parsed.shortcut.key, "d");
  }),
);

it.effect("parses resolved keybindings arrays", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
      {
        command: "thread.jump.3",
        shortcut: {
          key: "3",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ]);
    assert.lengthOf(parsed, 2);
  }),
);

it.effect("drops unknown fields in resolved keybinding rules", () =>
  decodeResolvedRule({
    command: "terminal.toggle",
    shortcut: {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    key: "mod+j",
  }).pipe(
    Effect.map((parsed) => {
      const view = parsed as Record<string, unknown>;
      assert.strictEqual("key" in view, false);
      assert.strictEqual(view.command, "terminal.toggle");
    }),
  ),
);
