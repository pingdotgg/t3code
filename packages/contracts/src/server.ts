import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;
