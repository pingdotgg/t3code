import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KimiSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { makeKimiAdapter } from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const kimiAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(kimiAdapterTestLayer)("KimiAdapter", (it) => {
  it.effect("constructs a standards-only ACP adapter for the kimi provider", () =>
    Effect.gen(function* () {
      const adapter = yield* makeKimiAdapter(
        decodeKimiSettings({ binaryPath: "/unused/kimi", homePath: "" }),
      );

      expect(adapter.provider).toBe(ProviderDriverKind.make("kimi"));
      expect(adapter.capabilities).toEqual({ sessionModelSwitch: "in-session" });
      expect(yield* adapter.listSessions()).toEqual([]);
    }),
  );

  it.effect("rejects a start request addressed to another provider before spawning", () =>
    Effect.gen(function* () {
      const adapter = yield* makeKimiAdapter(
        decodeKimiSettings({ binaryPath: "/unused/kimi", homePath: "" }),
        { instanceId: ProviderInstanceId.make("kimi") },
      );
      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("kimi-wrong-provider"),
          provider: ProviderDriverKind.make("cursor"),
          runtimeMode: "approval-required",
          cwd: process.cwd(),
        }),
      );

      expect(error._tag).toBe("ProviderAdapterValidationError");
    }),
  );
});
