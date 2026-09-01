import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { makeAcpNativeLoggerFactory } from "./AcpNativeLogging.ts";

const nodeServicesIt = it.layer(NodeServices.layer);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

nodeServicesIt("ACP native logging", (it) => {
  it.effect("records bounded request and protocol diagnostics without raw payloads", () =>
    Effect.gen(function* () {
      const records: Array<unknown> = [];
      const nativeEventLogger: EventNdjsonLogger = {
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

  it.effect("keeps request diagnostics without enabling full protocol logging", () =>
    Effect.gen(function* () {
      const records: Array<unknown> = [];
      const makeLogger = yield* makeAcpNativeLoggerFactory();
      const logger = makeLogger({
        nativeEventLogger: {
          filePath: "/tmp/provider-native.ndjson",
          write: (event) => Effect.sync(() => void records.push(event)),
          close: () => Effect.void,
        },
        provider: ProviderDriverKind.make("grok"),
        threadId: ThreadId.make("thread-1"),
      });

      assert.isUndefined(logger.protocolLogging);
      const requestLogger = logger.requestLogger;
      assert.exists(requestLogger);
      if (!requestLogger) return;
      yield* requestLogger({
        method: "session/prompt",
        payload: {},
        status: "started",
      });
      assert.lengthOf(records, 1);
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

  it.effect("keeps mixed and incomplete raw diagnostics", () =>
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

      const transient = encodeUnknownJson({
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk" } },
      });
      const lifecycle = encodeUnknownJson({ method: "session/new", params: {} });

      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        payload: `${transient}\n${lifecycle}\n`,
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        payload: transient,
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        payload: `${transient}\n{malformed}\n`,
      });

      assert.lengthOf(records, 3);
    }),
  );

  it.effect("filters transient entries from mixed decoded batches", () =>
    Effect.gen(function* () {
      const records: Array<unknown> = [];
      const makeLogger = yield* makeAcpNativeLoggerFactory();
      const logger = makeLogger({
        nativeEventLogger: {
          filePath: "/tmp/provider-native.ndjson",
          write: (event) => Effect.sync(() => void records.push(event)),
          close: () => Effect.void,
        },
        provider: ProviderDriverKind.make("grok"),
        threadId: ThreadId.make("thread-1"),
        verboseProtocolLogging: true,
      });
      const protocolLogger = logger.protocolLogging?.logger;
      assert.exists(protocolLogger);
      if (!protocolLogger) return;

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: [
          {
            _tag: "Request",
            tag: "session/update",
            payload: { update: { sessionUpdate: "agent_thought_chunk" } },
          },
          {
            _tag: "Request",
            tag: "session/new",
            payload: {},
          },
        ],
      });

      assert.lengthOf(records, 1);
      assert.include(encodeUnknownJson(records), '"itemCount":1');
    }),
  );

  it.effect("logs a structural tag when the native writer defects", () => {
    const messages: Array<unknown> = [];
    const logCapture = Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message)) {
        messages.push(...message);
      } else {
        messages.push(message);
      }
    });
    const secret = "secret-writer-failure";

    return Effect.gen(function* () {
      const makeLogger = yield* makeAcpNativeLoggerFactory();
      const logger = makeLogger({
        nativeEventLogger: {
          filePath: "/tmp/provider-native.ndjson",
          write: () => Effect.die(new Error(secret)),
          close: () => Effect.void,
        },
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
      });
      const requestLogger = logger.requestLogger;
      assert.exists(requestLogger);
      if (!requestLogger) return;

      yield* requestLogger({
        method: "session/prompt",
        payload: {},
        status: "started",
      });

      const serialized = encodeUnknownJson(messages);
      assert.notInclude(serialized, secret);
      assert.include(serialized, '"errorTag":"Die"');
      assert.include(serialized, '"reasonCount":1');
    }).pipe(Effect.provide(Logger.layer([logCapture], { mergeWithExisting: false })));
  });

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
