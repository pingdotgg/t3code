import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { ResolvedKeybindingsConfig } from "./keybindings.ts";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

it.effect("preserves Space shortcuts through the resolved keybindings JSON codec", () =>
  Effect.gen(function* () {
    const rules = [
      { command: "terminal.toggle", shortcut },
      {
        command: "composer.dictation",
        shortcut: { ...shortcut, key: " ", metaKey: true, modKey: false },
        whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
      },
    ] as const;
    const codec = Schema.toCodecJson(ResolvedKeybindingsConfig);
    const encoded = yield* Schema.encodeEffect(codec)(rules);
    assert.deepEqual(encoded, rules);
    assert.deepEqual(yield* decode(codec, encoded), rules);
  }),
);

it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "terminal.toggle", shortcut },
      { command: "someFuture.toggle", shortcut },
      { command: "filePicker.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle", "filePicker.toggle"],
    );
  }),
);

it.effect("drops malformed resolved rule entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      "garbage",
      { command: "composer.dictation", shortcut: { ...shortcut, key: "" } },
      { command: "composer.dictation", shortcut: { ...shortcut, key: "x".repeat(65) } },
      { command: "terminal.toggle", shortcut },
      null,
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle"],
    );
  }),
);
