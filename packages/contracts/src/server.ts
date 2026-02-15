import { z } from "zod";

export const keybindingCommandSchema = z.enum([
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
]);

const keybindingValueSchema = z.string().trim().min(1).max(64);
const keybindingWhenSchema = z.string().trim().min(1).max(256);

export const keybindingRuleSchema = z.object({
  key: keybindingValueSchema,
  command: keybindingCommandSchema,
  when: keybindingWhenSchema.optional(),
});

export const keybindingsConfigSchema = z.array(keybindingRuleSchema).max(256);

export const serverConfigSchema = z.object({
  cwd: z.string().min(1),
  keybindings: keybindingsConfigSchema.default([]),
});

export type KeybindingCommand = z.infer<typeof keybindingCommandSchema>;
export type KeybindingRule = z.infer<typeof keybindingRuleSchema>;
export type KeybindingsConfig = z.infer<typeof keybindingsConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
