import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

export const DesktopSpeechStateSchema = Schema.Literals([
  "missing-model",
  "downloading",
  "ready",
  "recording",
  "transcribing",
  "error",
]);
export type DesktopSpeechState = typeof DesktopSpeechStateSchema.Type;

export const DesktopSpeechStatusSchema = Schema.Union([
  Schema.Struct({
    supported: Schema.Literal(false),
    reason: Schema.String,
  }),
  Schema.Struct({
    supported: Schema.Literal(true),
    state: DesktopSpeechStateSchema,
    message: Schema.optionalKey(Schema.String),
  }),
]);
export type DesktopSpeechStatus = typeof DesktopSpeechStatusSchema.Type;

export const DesktopSpeechEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    status: DesktopSpeechStatusSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("download-progress"),
    downloaded: NonNegativeInt,
    total: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("level"),
    level: Schema.Number,
    elapsedMs: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
  }),
]);
export type DesktopSpeechEvent = typeof DesktopSpeechEventSchema.Type;
