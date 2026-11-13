// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import * as Path from "effect/Path";
import * as AcpError from "./errors.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { it, assert, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpSchema from "./schema.ts";
import * as AcpProtocol from "./protocol.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio, makeTerminationError, makeChildStdio } from "./_internal/stdio.ts";

export const SessionCancelNotification = jsonRpcNotification(
  "session/cancel",
  AcpSchema.CancelNotification,
);

export const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.SessionNotification,
);

export const ElicitationCompleteNotification = jsonRpcNotification(
  "elicitation/complete",
  AcpSchema.CompleteElicitationNotification,
);

export const RequestPermissionRequest = jsonRpcRequest(
  "session/request_permission",
  AcpSchema.RequestPermissionRequest,
);

export const RequestPermissionResponse = jsonRpcResponse(AcpSchema.RequestPermissionResponse);

export const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));

export const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));

export const decodeSessionCancelNotification = Schema.decodeEffect(
  Schema.fromJsonString(SessionCancelNotification),
);

export const decodeExtRequest = Schema.decodeEffect(Schema.fromJsonString(ExtRequest));

export const decodeRequestPermissionResponse = Schema.decodeEffect(
  Schema.fromJsonString(RequestPermissionResponse),
);

export const JsonRpcErrorResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
});

export const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const encoder = new TextEncoder();

export const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

export const mockPeerArgs = (path: string) => [path];

export const makeHandle = (env?: Record<string, string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
      cwd: path.join(import.meta.dirname, ".."),
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return yield* spawner.spawn(command);
  });
