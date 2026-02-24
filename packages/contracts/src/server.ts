import { Schema } from "effect";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";

export const ServerConfig = Schema.Struct({
  cwd: Schema.NonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
});
export type ServerConfig = Schema.Codec.Encoded<typeof ServerConfig>;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = Schema.Codec.Encoded<
  typeof ServerUpsertKeybindingInput
>;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
});
export type ServerUpsertKeybindingResult = Schema.Codec.Encoded<
  typeof ServerUpsertKeybindingResult
>;

