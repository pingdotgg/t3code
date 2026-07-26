import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  AntigravitySettings,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const antigravityAdapterTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-agy-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(antigravityAdapterTestLayer)("AntigravityAdapterLive", (it) => {
  it.effect("declares sessionModelSwitch as in-session in capabilities", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({}));
      assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");
      assert.equal(adapter.provider, ProviderDriverKind.make("antigravity"));
    }),
  );

  it.effect(
    "returns ProviderAdapterSessionNotFoundError for respondToRequest on unknown thread",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({}));
        const threadId = ThreadId.make("agy-nonexistent-thread");

        const error = yield* Effect.flip(
          adapter.respondToRequest(threadId, ApprovalRequestId.make("req-1"), "accept"),
        );

        assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      }),
  );

  it.effect(
    "returns ProviderAdapterSessionNotFoundError for respondToUserInput on unknown thread",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({}));
        const threadId = ThreadId.make("agy-nonexistent-thread");

        const error = yield* Effect.flip(
          adapter.respondToUserInput(threadId, ApprovalRequestId.make("req-1"), {}),
        );

        assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      }),
  );

  it.effect(
    "returns ProviderAdapterSessionNotFoundError for rollbackThread on unknown thread",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({}));
        const threadId = ThreadId.make("agy-nonexistent-thread");

        const error = yield* Effect.flip(adapter.rollbackThread(threadId, 1));

        assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      }),
  );
});
