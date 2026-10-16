import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import {
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchResult,
  OrchestrationV2ThreadProjection,
} from "./orchestrationV2.ts";
import { ServerProvider } from "./server.ts";

/**
 * Peer environments are the other environments a connected client can reach.
 * A server never talks to another server: it asks a client that is connected
 * to both, and the client runs the request over its own session there.
 */
export const PeerEnvironmentStatus = Schema.Literals([
  "connected",
  "offline",
  "unauthorized",
  "incompatible",
]);
export type PeerEnvironmentStatus = typeof PeerEnvironmentStatus.Type;

export const PeerEnvironmentSummary = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  status: PeerEnvironmentStatus,
});
export type PeerEnvironmentSummary = typeof PeerEnvironmentSummary.Type;

export const PeerEnvironmentHost = Schema.Struct({
  clientId: TrimmedNonEmptyString,
});
export type PeerEnvironmentHost = typeof PeerEnvironmentHost.Type;

export const PeerEnvironmentOperation = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("list") }),
  Schema.Struct({ operation: Schema.Literal("catalog"), environmentId: EnvironmentId }),
  Schema.Struct({
    operation: Schema.Literal("launch"),
    environmentId: EnvironmentId,
    input: OrchestrationV2ThreadLaunchInput,
  }),
  Schema.Struct({
    operation: Schema.Literal("thread_projection"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
  }),
]);
export type PeerEnvironmentOperation = typeof PeerEnvironmentOperation.Type;

export const PeerEnvironmentResult = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("list"),
    environments: Schema.Array(PeerEnvironmentSummary),
  }),
  Schema.Struct({
    operation: Schema.Literal("catalog"),
    label: Schema.String,
    serverVersion: Schema.String,
    providers: Schema.Array(ServerProvider),
    projects: Schema.Array(OrchestrationProjectShell),
  }),
  Schema.Struct({
    operation: Schema.Literal("launch"),
    result: OrchestrationV2ThreadLaunchResult,
  }),
  Schema.Struct({
    operation: Schema.Literal("thread_projection"),
    projection: OrchestrationV2ThreadProjection,
  }),
]);
export type PeerEnvironmentResult = typeof PeerEnvironmentResult.Type;

export const PeerEnvironmentFailureCode = Schema.Literals([
  "environment_not_connected",
  "environment_offline",
  "environment_unauthorized",
  "environment_incompatible",
  "environment_request_failed",
]);
export type PeerEnvironmentFailureCode = typeof PeerEnvironmentFailureCode.Type;

export const PeerEnvironmentRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  operation: PeerEnvironmentOperation,
  timeoutMs: Schema.Number,
});
export type PeerEnvironmentRequest = typeof PeerEnvironmentRequest.Type;

export const PeerEnvironmentStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: TrimmedNonEmptyString,
    request: PeerEnvironmentRequest,
  }),
]);
export type PeerEnvironmentStreamEvent = typeof PeerEnvironmentStreamEvent.Type;

export const PeerEnvironmentResponse = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  connectionId: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  outcome: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), result: PeerEnvironmentResult }),
    Schema.Struct({
      ok: Schema.Literal(false),
      code: PeerEnvironmentFailureCode,
      message: Schema.String,
    }),
  ]),
});
export type PeerEnvironmentResponse = typeof PeerEnvironmentResponse.Type;
