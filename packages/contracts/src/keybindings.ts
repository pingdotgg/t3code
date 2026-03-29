import { Schema } from "effect";
import { TrimmedString } from "./baseSchemas";

export const MAX_KEYBINDING_VALUE_LENGTH = 64;
const MAX_KEYBINDING_WHEN_LENGTH = 256;
export const MAX_WHEN_EXPRESSION_DEPTH = 64;
export const MAX_SCRIPT_ID_LENGTH = 24;
export const MAX_KEYBINDINGS_COUNT = 256;

export const THREAD_JUMP_KEYBINDING_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const;
export type ThreadJumpKeybindingCommand = (typeof THREAD_JUMP_KEYBINDING_COMMANDS)[number];

export const THREAD_KEYBINDING_COMMANDS = [
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
] as const;
export type ThreadKeybindingCommand = (typeof THREAD_KEYBINDING_COMMANDS)[number];

const STATIC_KEYBINDING_COMMANDS = [
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
  "terminal.close",
  "diff.toggle",
  "chat.new",
  "chat.newLocal",
  "editor.openFavorite",
  ...THREAD_KEYBINDING_COMMANDS,
] as const;

export const SCRIPT_RUN_COMMAND_PATTERN = Schema.TemplateLiteral([
  Schema.Literal("script."),
  Schema.NonEmptyString.check(
    Schema.isMaxLength(MAX_SCRIPT_ID_LENGTH),
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  ),
  Schema.Literal(".run"),
]);

export const KeybindingCommand = Schema.Union([
  Schema.Literals(STATIC_KEYBINDING_COMMANDS),
  SCRIPT_RUN_COMMAND_PATTERN,
]);
export type KeybindingCommand = typeof KeybindingCommand.Type;

const KeybindingValue = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_VALUE_LENGTH),
);

const KeybindingWhen = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_WHEN_LENGTH),
);
export const KeybindingRule = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});
export type KeybindingRule = typeof KeybindingRule.Type;

export const KeybindingsConfig = Schema.Array(KeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type KeybindingsConfig = typeof KeybindingsConfig.Type;

export const KeybindingShortcut = Schema.Struct({
  key: KeybindingValue,
  metaKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
  altKey: Schema.Boolean,
  modKey: Schema.Boolean,
});
export type KeybindingShortcut = typeof KeybindingShortcut.Type;

export const KeybindingWhenNode: Schema.Schema<KeybindingWhenNode> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("identifier"),
    name: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("not"),
    node: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
  }),
  Schema.Struct({
    type: Schema.Literal("and"),
    left: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
    right: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
  }),
  Schema.Struct({
    type: Schema.Literal("or"),
    left: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
    right: Schema.suspend((): Schema.Schema<KeybindingWhenNode> => KeybindingWhenNode),
  }),
]);
export type KeybindingWhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: KeybindingWhenNode }
  | { type: "and"; left: KeybindingWhenNode; right: KeybindingWhenNode }
  | { type: "or"; left: KeybindingWhenNode; right: KeybindingWhenNode };

export const ResolvedKeybindingRule = Schema.Struct({
  command: KeybindingCommand,
  shortcut: KeybindingShortcut,
  whenAst: Schema.optional(KeybindingWhenNode),
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
export type ResolvedKeybindingRule = typeof ResolvedKeybindingRule.Type;

export const ResolvedKeybindingsConfig = Schema.Array(ResolvedKeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type ResolvedKeybindingsConfig = typeof ResolvedKeybindingsConfig.Type;
