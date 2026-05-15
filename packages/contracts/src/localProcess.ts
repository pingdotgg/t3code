import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const LocalPort = PositiveInt.check(Schema.isLessThanOrEqualTo(65_535));

export const LocalProcessStopPortsInput = Schema.Struct({
  ports: Schema.Array(LocalPort).check(Schema.isMinLength(1)).check(Schema.isMaxLength(16)),
});
export type LocalProcessStopPortsInput = typeof LocalProcessStopPortsInput.Type;

export const LocalProcessStopPortResult = Schema.Struct({
  port: LocalPort,
  killedPids: Schema.Array(PositiveInt),
  errors: Schema.Array(Schema.String),
});
export type LocalProcessStopPortResult = typeof LocalProcessStopPortResult.Type;

export const LocalProcessStopPortsResult = Schema.Struct({
  results: Schema.Array(LocalProcessStopPortResult),
});
export type LocalProcessStopPortsResult = typeof LocalProcessStopPortsResult.Type;

export class LocalProcessStopPortsError extends Schema.TaggedErrorClass<LocalProcessStopPortsError>()(
  "LocalProcessStopPortsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const LocalProcessProbePortsInput = Schema.Struct({
  ports: Schema.Array(LocalPort).check(Schema.isMinLength(1)).check(Schema.isMaxLength(32)),
});
export type LocalProcessProbePortsInput = typeof LocalProcessProbePortsInput.Type;

export const LocalProcessProbePortResult = Schema.Struct({
  port: LocalPort,
  isListening: Schema.Boolean,
  pids: Schema.Array(PositiveInt),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
export type LocalProcessProbePortResult = typeof LocalProcessProbePortResult.Type;

export const LocalProcessProbePortsResult = Schema.Struct({
  results: Schema.Array(LocalProcessProbePortResult),
});
export type LocalProcessProbePortsResult = typeof LocalProcessProbePortsResult.Type;

export class LocalProcessProbePortsError extends Schema.TaggedErrorClass<LocalProcessProbePortsError>()(
  "LocalProcessProbePortsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
