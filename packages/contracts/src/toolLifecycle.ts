import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { CanonicalJsonObjectSchema, CanonicalJsonValueSchema } from "./jsonValue";

export const CommandExecutionToolLifecycleData = Schema.Struct({
  kind: Schema.Literal("command_execution"),
  command: TrimmedNonEmptyString,
  toolName: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(CanonicalJsonObjectSchema),
  output: Schema.optional(Schema.String),
  exitCode: Schema.optional(NonNegativeInt),
  result: Schema.optional(CanonicalJsonValueSchema),
});
export type CommandExecutionToolLifecycleData = typeof CommandExecutionToolLifecycleData.Type;

export const FileChangeToolLifecycleData = Schema.Struct({
  kind: Schema.Literal("file_change"),
  changedFiles: Schema.Array(TrimmedNonEmptyString),
  toolName: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(CanonicalJsonObjectSchema),
  result: Schema.optional(CanonicalJsonValueSchema),
});
export type FileChangeToolLifecycleData = typeof FileChangeToolLifecycleData.Type;

export const GenericToolLifecycleData = Schema.Struct({
  kind: Schema.Literal("generic"),
  toolName: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(CanonicalJsonObjectSchema),
  result: Schema.optional(CanonicalJsonValueSchema),
});
export type GenericToolLifecycleData = typeof GenericToolLifecycleData.Type;

export const CanonicalToolLifecycleData = Schema.Union([
  CommandExecutionToolLifecycleData,
  FileChangeToolLifecycleData,
  GenericToolLifecycleData,
]);
export type CanonicalToolLifecycleData = typeof CanonicalToolLifecycleData.Type;
