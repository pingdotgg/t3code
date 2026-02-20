import { z } from "zod";

export const STATIC_KEYBINDING_COMMANDS = [
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
  "terminal.close",
  "chat.new",
  "chat.newLocal",
  "editor.openFavorite",
] as const;

export const keybindingCommandSchema = z.union([
  z.enum(STATIC_KEYBINDING_COMMANDS),
  z
    .string()
    .trim()
    .min(1)
    .max(96)
    .regex(/^script\.[a-z0-9][a-z0-9-]*\.run$/),
]);

const keybindingValueSchema = z.string().trim().min(1).max(64);
const keybindingWhenSchema = z.string().trim().min(1).max(256);

export const keybindingRuleSchema = z.object({
  key: keybindingValueSchema,
  command: keybindingCommandSchema,
  when: keybindingWhenSchema.optional(),
});

export const keybindingsConfigSchema = z.array(keybindingRuleSchema).max(256);

export const keybindingShortcutSchema = z
  .object({
    key: z.string().trim().min(1).max(32),
    metaKey: z.boolean(),
    ctrlKey: z.boolean(),
    shiftKey: z.boolean(),
    altKey: z.boolean(),
    modKey: z.boolean(),
  })
  .strict();

export type KeybindingWhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: KeybindingWhenNode }
  | { type: "and"; left: KeybindingWhenNode; right: KeybindingWhenNode }
  | { type: "or"; left: KeybindingWhenNode; right: KeybindingWhenNode };

export const keybindingWhenNodeSchema: z.ZodType<KeybindingWhenNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal("identifier"),
      name: z.string().min(1),
    }),
    z.object({
      type: z.literal("not"),
      node: keybindingWhenNodeSchema,
    }),
    z.object({
      type: z.literal("and"),
      left: keybindingWhenNodeSchema,
      right: keybindingWhenNodeSchema,
    }),
    z.object({
      type: z.literal("or"),
      left: keybindingWhenNodeSchema,
      right: keybindingWhenNodeSchema,
    }),
  ]),
);

export const resolvedKeybindingRuleSchema = z
  .object({
    command: keybindingCommandSchema,
    shortcut: keybindingShortcutSchema,
    whenAst: keybindingWhenNodeSchema.optional(),
  })
  .strict();

export const resolvedKeybindingsConfigSchema = z.array(resolvedKeybindingRuleSchema).max(256);

export type KeybindingCommand = z.infer<typeof keybindingCommandSchema>;
export type KeybindingRule = z.infer<typeof keybindingRuleSchema>;
export type KeybindingsConfig = z.infer<typeof keybindingsConfigSchema>;
export type KeybindingShortcut = z.infer<typeof keybindingShortcutSchema>;
export type ResolvedKeybindingRule = z.infer<typeof resolvedKeybindingRuleSchema>;
export type ResolvedKeybindingsConfig = z.infer<typeof resolvedKeybindingsConfigSchema>;
