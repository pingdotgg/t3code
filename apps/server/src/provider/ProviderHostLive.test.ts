import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

const managedPolicy = { organization: "Example Corp", lockedSettings: [] };

// Provider packages enforce policy through this field; without it they fail open.
it.effect("gives providers the managed policy", () =>
  Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost;
    assert.deepEqual(host.managedPolicy, managedPolicy);
  }).pipe(
    Effect.provide(
      ProviderHostLive.layer.pipe(
        Layer.provideMerge(
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
          }),
        ),
        Layer.provideMerge(ServerSettings.layerTest({}, managedPolicy)),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-host-test-" }).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
    ),
  ),
);
