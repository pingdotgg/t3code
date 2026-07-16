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
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

nodeServicesIt("ACP native logging", (it) => {
  it.effect("records bounded request and protocol diagnostics without raw payloads", () =>
    Effect.gen(function* () {
      const records: Array<unknown> = [];
      const nativeEventLogger: EventNdjsonLogger = {
        filePath: "/tmp/provider-native.ndjson",
        write: (event) => Effect.sync(() => void records.push(event)),
      };
      const makeLogger = yield* makeAcpNativeLoggerFactory();
      const logger = makeLogger({
        nativeEventLogger,
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("thread-1"),
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
