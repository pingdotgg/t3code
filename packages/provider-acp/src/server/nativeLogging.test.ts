import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeAcpNativeLoggerFactory } from "./nativeLogging.ts";

const nodeServicesIt = it.layer(NodeServices.layer);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

nodeServicesIt("ACP native logging", (it) => {
  it.effect("records bounded request and protocol diagnostics without raw payloads", () =>
    Effect.gen(function* () {
      const records: Array<unknown> = [];
      const nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/provider-native.ndjson",
        write: (event) => Effect.sync(() => void records.push(event)),
        close: () => Effect.void,
      };
      const makeLogger = yield* makeAcpNativeLoggerFactory();
      const logger = makeLogger({
        nativeEventLogger,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        verboseProtocolLogging: true,
      });
      const secret = "secret-token-value";
      const requestLogger = logger.requestLogger;
      const protocolLogger = logger.protocolLogging?.logger;
      assert.exists(requestLogger);
      assert.exists(protocolLogger);
      if (!requestLogger || !protocolLogger) return;

      yield* requestLogger({
        method: "session/prompt",
        payload: { prompt: secret, sessionId: secret },
        status: "failed",
        cause: Cause.fail(AcpErrors.AcpRequestError.internalError(secret, { token: secret })),
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        payload: `{"token":"${secret}"}`,
      });
      yield* protocolLogger({
        direction: "outgoing",
        stage: "decoded",
        payload: {
          _tag: "Request",
          tag: "session/prompt",
          payload: { prompt: secret },
        },
      });

      const serialized = encodeUnknownJson(records);
      assert.notInclude(serialized, secret);
      assert.include(serialized, '"method":"session/prompt"');
      assert.include(serialized, '"errorTag":"AcpRequestError"');
      assert.include(serialized, '"reasonCount":1');
      assert.include(serialized, '"valueType":"string"');
      assert.include(serialized, '"messageTag":"Request"');
    }),
  );

  it.effect("drops transient ACP chunks before formatting verbose protocol logs", () =>
    Effect.gen(function* () {
      const records: Array<unknown> = [];
      const makeLogger = yield* makeAcpNativeLoggerFactory();
      const logger = makeLogger({
        nativeEventLogger: {
          filePath: "/tmp/provider-native.ndjson",
          write: (event) => Effect.sync(() => void records.push(event)),
          close: () => Effect.void,
        },
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
        verboseProtocolLogging: true,
      });
      const protocolLogger = logger.protocolLogging?.logger;
      assert.exists(protocolLogger);
      if (!protocolLogger) return;

      for (const updateType of ["agent_message_chunk", "agent_thought_chunk"] as const) {
        yield* protocolLogger({
          direction: "incoming",
          stage: "raw",
          payload: `${encodeUnknownJson({
            method: "session/update",
            params: { update: { sessionUpdate: updateType } },
          })}\n`,
        });
        yield* protocolLogger({
          direction: "incoming",
          stage: "decoded",
          payload: [
            {
              _tag: "Request",
              tag: "session/update",
              payload: { update: { sessionUpdate: updateType } },
            },
          ],
        });
      }

      assert.lengthOf(records, 0);

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: [
          {
            _tag: "Request",
            tag: "session/update",
            payload: { update: { sessionUpdate: "tool_call" } },
          },
        ],
      });
      assert.lengthOf(records, 1);
    }),
  );

  it.effect("preserves native writer interruption", () =>
    Effect.gen(function* () {
      const makeLogger = yield* makeAcpNativeLoggerFactory();
      const logger = makeLogger({
        nativeEventLogger: {
          filePath: "/tmp/provider-native.ndjson",
          write: () => Effect.interrupt,
          close: () => Effect.void,
        },
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
      });
      const requestLogger = logger.requestLogger;
      assert.exists(requestLogger);
      if (!requestLogger) return;

      const exit = yield* requestLogger({
        method: "session/prompt",
        payload: {},
        status: "started",
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      }
    }),
  );
});
