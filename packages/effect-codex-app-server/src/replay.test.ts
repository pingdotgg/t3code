import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import * as CodexError from "./errors.ts";
import * as CodexReplay from "./replay.ts";

const isCodexAppServerTransportError = Schema.is(CodexError.CodexAppServerTransportError);
const decodeReplayError = Schema.decodeUnknownEffect(CodexReplay.CodexAppServerReplayError);
const encodeReplayError = Schema.encodeUnknownEffect(CodexReplay.CodexAppServerReplayError);

const initializeParams = {
  clientInfo: {
    name: "effect-codex-app-server-test",
    title: "Effect Codex App Server Test",
    version: "0.0.0",
  },
  capabilities: {
    experimentalApi: true,
    optOutNotificationMethods: null,
  },
} as const;

const initializeResponse = {
  userAgent: "replay-codex-app-server",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "macos",
} as const;

function buildContext(transcript: CodexReplay.CodexAppServerReplayTranscript) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(CodexReplay.layerReplay(transcript), scope);
    return { context, scope };
  });
}

it.effect("replays Codex app-server frames through the real client protocol", () =>
  Effect.gen(function* () {
    const { context, scope } = yield* buildContext({
      provider: "codex",
      protocol: "codex.app-server",
      version: "test",
      scenario: "initialize",
      entries: [
        {
          type: "expect_outbound",
          label: "initialize",
          frame: {
            id: 1,
            method: "initialize",
            params: {
              ...initializeParams,
              clientInfo: {
                ...initializeParams.clientInfo,
                version: "older-fixture-version",
              },
            },
          },
        },
        {
          type: "emit_inbound",
          label: "initialize",
          frame: {
            id: 1,
            result: initializeResponse,
          },
        },
        {
          type: "expect_outbound",
          label: "initialized",
          frame: {
            method: "initialized",
          },
        },
        {
          type: "runtime_exit",
          status: "success",
        },
      ],
    });

    yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      assert.deepEqual(yield* client.request("initialize", initializeParams), initializeResponse);
      yield* client.notify("initialized", undefined);
    }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
  }),
);

it.effect("fails pending client requests with a schema-serializable replay mismatch", () =>
  Effect.gen(function* () {
    const { context, scope } = yield* buildContext({
      provider: "codex",
      protocol: "codex.app-server",
      version: "test",
      scenario: "mismatch",
      entries: [
        {
          type: "expect_outbound",
          label: "initialize",
          frame: {
            id: 1,
            method: "initialize",
            params: initializeParams,
          },
        },
        {
          type: "runtime_exit",
          status: "success",
        },
      ],
    });

    const error = yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      return yield* client.request("account/read", {});
    }).pipe(Effect.provide(context), Effect.flip, Effect.ensuring(Scope.close(scope, Exit.void)));

    assert.equal(error._tag, "CodexAppServerTransportError");
    if (!isCodexAppServerTransportError(error)) {
      throw new Error("Expected transport error.");
    }

    const replayError = yield* decodeReplayError(error.cause);
    const encoded = yield* encodeReplayError(replayError);

    assert.equal(encoded._tag, "CodexAppServerReplayFrameMismatchError");
    if (encoded._tag !== "CodexAppServerReplayFrameMismatchError") {
      throw new Error("Expected frame mismatch error.");
    }
    assert.equal(encoded.scenario, "mismatch");
    assert.equal(encoded.cursor, 0);
    assert.deepEqual(encoded.actual, {
      id: 1,
      method: "account/read",
      params: {},
    });
  }),
);
