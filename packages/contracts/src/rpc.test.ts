import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  ORCHESTRATION_THREAD_NOT_FOUND_ERROR_CAPABILITY,
  OrchestrationGetSnapshotError,
  OrchestrationThreadNotFoundError,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import { WsSubscribeServerConfigRpc } from "./rpc.ts";

const decodeLegacyServerConfigPayload = Schema.decodeUnknownExit(Schema.Struct({}));
const decodeServerConfigPayload = Schema.decodeUnknownSync(
  WsSubscribeServerConfigRpc.payloadSchema,
);
const threadId = ThreadId.make("thread-version-skew");
const decodeLegacySubscribeThreadPayload = Schema.decodeUnknownSync(
  Schema.Struct({ threadId: ThreadId }),
);
const decodeBooleanEraSubscribeThreadPayload = Schema.decodeUnknownSync(
  Schema.Struct({
    threadId: ThreadId,
    threadNotFoundError: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeSubscribeThreadPayload = Schema.decodeUnknownSync(
  OrchestrationRpcSchemas.subscribeThread.input,
);
const legacySubscribeThreadError = Schema.Union([
  OrchestrationGetSnapshotError,
  EnvironmentAuthorizationError,
]);
const decodeLegacySubscribeThreadError = Schema.decodeUnknownExit(
  Schema.toCodecJson(legacySubscribeThreadError),
);
const encodeSnapshotError = Schema.encodeUnknownSync(
  Schema.toCodecJson(OrchestrationGetSnapshotError),
);
const encodeThreadNotFoundError = Schema.encodeUnknownSync(
  Schema.toCodecJson(OrchestrationThreadNotFoundError),
);

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const decoded = decodeLegacyServerConfigPayload({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = decodeServerConfigPayload({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = decodeServerConfigPayload({});
    expect(decoded).toEqual({});
  });
});

describe("subscribeThread missing-error compatibility", () => {
  it("allows the current payload when a server predates both opt-ins", () => {
    const decoded = decodeLegacySubscribeThreadPayload({
      threadId,
      capabilities: [ORCHESTRATION_THREAD_NOT_FOUND_ERROR_CAPABILITY],
      threadNotFoundError: true,
    });
    expect(decoded).toEqual({ threadId });
  });

  it("preserves the legacy opt-in when a boolean-era server drops capabilities", () => {
    const decoded = decodeBooleanEraSubscribeThreadPayload({
      threadId,
      capabilities: [ORCHESTRATION_THREAD_NOT_FOUND_ERROR_CAPABILITY],
      threadNotFoundError: true,
    });
    expect(decoded).toEqual({ threadId, threadNotFoundError: true });
  });

  it("carries the versioned capability on current servers and keeps it optional", () => {
    expect(
      decodeSubscribeThreadPayload({
        threadId,
        capabilities: [ORCHESTRATION_THREAD_NOT_FOUND_ERROR_CAPABILITY],
      }),
    ).toEqual({
      threadId,
      capabilities: [ORCHESTRATION_THREAD_NOT_FOUND_ERROR_CAPABILITY],
    });
    expect(decodeSubscribeThreadPayload({ threadId })).toEqual({ threadId });
  });

  it("continues to decode the legacy boolean opt-in", () => {
    expect(decodeSubscribeThreadPayload({ threadId, threadNotFoundError: true })).toEqual({
      threadId,
      threadNotFoundError: true,
    });
  });

  it("keeps unknown future capability names decodable", () => {
    expect(
      decodeSubscribeThreadPayload({
        threadId,
        capabilities: ["orchestration.thread-not-found-error.v2"],
      }),
    ).toEqual({
      threadId,
      capabilities: ["orchestration.thread-not-found-error.v2"],
    });
  });

  it("keeps the non-opted-in fallback decodable by legacy clients", () => {
    const fallback = new OrchestrationGetSnapshotError({
      message: `Thread ${threadId} was not found`,
      cause: threadId,
    });
    const encoded = encodeSnapshotError(fallback);
    const decoded = decodeLegacySubscribeThreadError(encoded);
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("shows why the dedicated error must be negotiated", () => {
    const encoded = encodeThreadNotFoundError(new OrchestrationThreadNotFoundError({ threadId }));
    const decoded = decodeLegacySubscribeThreadError(encoded);
    expect(Exit.isFailure(decoded)).toBe(true);
  });
});
