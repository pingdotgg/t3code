import * as Schema from "effect/Schema";

// Upstream's published ClientRequest union omits these experimental methods.
export const ExperimentalRealtimeWebrtcStartParams = Schema.Struct({
  threadId: Schema.String,
  outputModality: Schema.Literal("audio"),
  version: Schema.Literal("v3"),
  transport: Schema.Struct({
    type: Schema.Literal("webrtc"),
    sdp: Schema.NonEmptyString,
  }),
  voice: Schema.optionalKey(Schema.NullOr(Schema.String)),
  includeStartupContext: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  clientManagedHandoffs: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export type ExperimentalRealtimeWebrtcStartParams =
  typeof ExperimentalRealtimeWebrtcStartParams.Type;

export const ExperimentalRealtimeStopParams = Schema.Struct({ threadId: Schema.String });
export type ExperimentalRealtimeStopParams = typeof ExperimentalRealtimeStopParams.Type;

export const ExperimentalRealtimeResponse = Schema.Struct({});
export type ExperimentalRealtimeResponse = typeof ExperimentalRealtimeResponse.Type;
