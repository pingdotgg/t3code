// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpError from "./errors.ts";
import type * as AcpCompat from "./compat.ts";
import type * as AcpProtocol from "./protocol.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import antigravityInitialize from "../test/fixtures/antigravity-initialize.json" with { type: "json" };

export const InitializeRequest = jsonRpcRequest("initialize", AcpSchema.InitializeRequest);

export const InitializeResponse = jsonRpcResponse(AcpSchema.InitializeResponse);

export const InitializeRequestV1 = jsonRpcRequest("initialize", AcpSchemaV1.InitializeRequest);

export const InitializeResponseV1 = jsonRpcResponse(AcpSchemaV1.InitializeResponse);

export const NewSessionRequestV1 = jsonRpcRequest("session/new", AcpSchemaV1.NewSessionRequest);

export const PromptRequestV1 = jsonRpcRequest("session/prompt", AcpSchemaV1.PromptRequest);

export const PromptResponseV1 = jsonRpcResponse(AcpSchemaV1.PromptResponse);

export const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));

export const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));

export const PromptRequest = jsonRpcRequest("session/prompt", AcpSchema.PromptRequest);

export const PromptResponse = jsonRpcResponse(AcpSchema.PromptResponse);

export const SessionUpdateNotification = jsonRpcNotification("session/update", Schema.Unknown);

export const PermissionRequest = jsonRpcRequest(
  "session/request_permission",
  AcpSchema.RequestPermissionRequest,
);

export const PermissionResponse = jsonRpcResponse(AcpSchema.RequestPermissionResponse);

export const ErrorResponse = Schema.Struct({ id: Schema.String, error: Schema.Unknown });

export const DieResponse = Schema.Struct({
  id: Schema.String,
  error: Schema.TaggedStruct("Cause", { data: Schema.Tuple([Schema.TaggedStruct("Die", {})]) }),
});

export const decodePromptRequestLine = Schema.decodeEffect(Schema.fromJsonString(PromptRequest));

export const XAiPromptCompleteNotification = jsonRpcNotification(
  "_x.ai/session/prompt_complete",
  Schema.Struct({
    sessionId: Schema.String,
    promptId: Schema.String,
    stopReason: Schema.String,
    agentResult: Schema.NullOr(Schema.Unknown),
  }),
);

export const XAiQueueChangedNotification = jsonRpcNotification(
  "_x.ai/queue/changed",
  Schema.Struct({
    sessionId: Schema.String,
    entries: Schema.Array(Schema.Unknown),
  }),
);

export const XAiSessionsChangedNotification = jsonRpcNotification(
  "_x.ai/sessions/changed",
  Schema.Struct({
    upserted: Schema.Array(Schema.Unknown),
    removed: Schema.Array(Schema.Unknown),
  }),
);

export const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

export const mockPeerArgs = (path: string) => [path];

export const mockStartupNotice = "Mock ACP startup notice";

export const stripMockStartupNotice = (stdout: ChildProcessSpawner.ChildProcessHandle["stdout"]) =>
  stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line !== mockStartupNotice),
    Stream.map((line) => `${line}\n`),
    Stream.encodeText,
  );

export function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const batch = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    batch.set(chunk, offset);
    offset += chunk.length;
  }
  return batch;
}

export const elicitationForm = {
  sessionId: "session-1",
  mode: "form" as const,
  message: "Continue?",
  requestedSchema: {
    type: "object" as const,
    properties: { choice: { type: "string" as const } },
    required: ["choice"],
  },
};

export const decodeWireResponse = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export const decodeWireError = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.Finite }) })),
);
