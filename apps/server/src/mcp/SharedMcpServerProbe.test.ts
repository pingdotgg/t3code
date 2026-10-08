import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SharedMcpProxy from "./SharedMcpProxy.ts";
import * as SharedMcpServerProbe from "./SharedMcpServerProbe.ts";

const layerEmptySecretStore = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.die("unused"),
    remove: () => Effect.void,
  }),
);

const layer = SharedMcpServerProbe.layer.pipe(
  Layer.provide(
    SharedMcpProxy.layer.pipe(
      Layer.provide(Layer.mergeAll(layerEmptySecretStore, NodeCrypto.layer)),
    ),
  ),
  Layer.provide(
    ServerSettings.layerTest({
      sharedMcpServers: [
        // Port 9 (discard) refuses connections, so the probe fails fast.
        { name: "offline", url: "http://127.0.0.1:9/mcp", enabled: true, headers: {} },
      ],
    }).pipe(Layer.orDie),
  ),
);

it.effect("reports a server that is no longer saved", () =>
  Effect.gen(function* () {
    const probe = yield* SharedMcpServerProbe.SharedMcpServerProbe;
    const error = yield* probe.test({ name: "missing" }).pipe(Effect.flip);
    assert.equal(error.message, "This server is no longer saved.");
  }).pipe(Effect.provide(layer)),
);

it.effect("turns an unreachable server into a readable test failure", () =>
  Effect.gen(function* () {
    const probe = yield* SharedMcpServerProbe.SharedMcpServerProbe;
    const error = yield* probe.test({ name: "offline" }).pipe(Effect.flip);
    assert.equal(error._tag, "SharedMcpServerTestError");
    assert.equal(error.server, "offline");
  }).pipe(Effect.provide(layer)),
);
