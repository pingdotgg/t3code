import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { makeDevinAdapter } from "../Layers/DevinAdapter.ts";
import { DevinDriver } from "../Drivers/DevinDriver.ts";

describe("DevinAdapter", () => {
  it.effect("can be constructed and reports no sessions initially", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDevinAdapter(DevinDriver.defaultConfig(), {
        environment: process.env,
        instanceId: ProviderInstanceId.make("devin-adapter-test"),
      });

      const has = yield* adapter.hasSession(ThreadId.make("unknown-thread"));
      expect(has).toBe(false);

      const sessions = yield* adapter.listSessions();
      expect(sessions).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
