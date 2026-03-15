import { Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  KeybindingsConfig,
  KeybindingRule,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "./keybindings";

it.effect("parses keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(KeybindingRule)({
      key: "mod+j",
      command: "terminal.toggle",
    });
    assert.strictEqual(parsed.command, "terminal.toggle");

    const parsedClose = yield* Schema.decodeUnknownEffect(KeybindingRule)({
      key: "mod+w",
      command: "terminal.close",
    });
    assert.strictEqual(parsedClose.command, "terminal.close");

    const parsedDiffToggle = yield* Schema.decodeUnknownEffect(KeybindingRule)({
      key: "mod+d",
      command: "diff.toggle",
    });
    assert.strictEqual(parsedDiffToggle.command, "diff.toggle");

    const parsedLocal = yield* Schema.decodeUnknownEffect(KeybindingRule)({
      key: "mod+shift+n",
      command: "chat.newLocal",
    });
    assert.strictEqual(parsedLocal.command, "chat.newLocal");
  }),
);

it.effect("rejects invalid command values", () =>
  // oxlint-disable-next-line require-yield
  Effect.gen(function* () {
    const result = Schema.decodeUnknownExit(KeybindingRule)({
      key: "mod+j",
      command: "script.Test.run",
    });
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts dynamic script run commands", () =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownExit(KeybindingRule)({
      key: "mod+r",
      command: "script.setup.run",
    });
    assert.strictEqual(parsed.command, "script.setup.run");
  }),
);

it.effect("parses keybindings array payload", () =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownExit(KeybindingsConfig)([
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
    ]);
    assert.lengthOf(parsed, 2);
  }),
);

it.effect("parses resolved keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownExit(ResolvedKeybindingRule)({
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
    const parsed = yield* Schema.decodeUnknownExit(ResolvedKeybindingsConfig)([
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
    ]);
    assert.lengthOf(parsed, 1);
  }),
);

it.effect("drops unknown fields in resolved keybinding rules", () =>
  Schema.decodeUnknownExit(ResolvedKeybindingRule)({
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
      assert.strictEqual("key" in parsed, false);
      assert.strictEqual(parsed.command, "terminal.toggle");
    }),
  ),
);
