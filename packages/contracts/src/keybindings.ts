import { Schema } from "effect";

export const STATIC_KEYBINDING_COMMANDS = [
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
  "terminal.close",
  "chat.new",
  "chat.newLocal",
  "editor.openFavorite",
] as const;

export const KeybindingCommand = Schema.Union([
  Schema.Literals(STATIC_KEYBINDING_COMMANDS),
  Schema.NonEmptyString.check(
    Schema.isMaxLength(96),
    Schema.isPattern(/^script\.[a-z0-9][a-z0-9-]*\.run$/),
  ),
]);
export type KeybindingCommand = typeof KeybindingCommand.Type;

export const KeybindingValue = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));
export type KeybindingValue = typeof KeybindingValue.Type;

export const KeybindingWhen = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export type KeybindingWhen = typeof KeybindingWhen.Type;
export class KeybindingRule extends Schema.Class<KeybindingRule>("KeybindingRule")({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
}) {}

export const KeybindingsConfig = Schema.Array(KeybindingRule).check(Schema.isMaxLength(256));
export type KeybindingsConfig = typeof KeybindingsConfig.Type;

export class KeybindingShortcut extends Schema.Class<KeybindingShortcut>("KeybindingShortcut")({
  key: KeybindingValue,
  metaKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
  altKey: Schema.Boolean,
  modKey: Schema.Boolean,
}) {}

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

export class ResolvedKeybindingRule extends Schema.Class<ResolvedKeybindingRule>(
  "ResolvedKeybindingRule",
)(
  {
    command: KeybindingCommand,
    shortcut: KeybindingShortcut,
    whenAst: Schema.optional(KeybindingWhenNode),
  },
  { parseOptions: { onExcessProperty: "error" } },
) {}

export const ResolvedKeybindingsConfig = Schema.Array(ResolvedKeybindingRule).check(
  Schema.isMaxLength(256),
);
export type ResolvedKeybindingsConfig = typeof ResolvedKeybindingsConfig.Type;
