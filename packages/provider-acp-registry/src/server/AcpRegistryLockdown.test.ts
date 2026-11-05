import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AcpRegistryPrepareInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const prepareInput = Schema.decodeSync(AcpRegistryPrepareInput)({ agentId: "devin" });
const registrySettings = decodeSettings({ source: "registry", agentId: "devin" });
const localSettings = decodeSettings({ source: "local", commandPath: process.execPath });

// Both die on any call: no registry operation may reach the network or a
// package manager.
const NoEgressLayer = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.die(`unexpected HTTP request: ${request.url}`)),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unexpected process spawn")),
  ),
);

const CatalogLayer = AcpRegistrySupport.layerFromHost.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      Layer.succeed(HostProcess.Platform, "linux"),
      Layer.succeed(HostProcess.Architecture, "x64"),
      Layer.succeed(HostProcess.Environment, { PATH: "/usr/bin:/bin" }),
    ),
  ),
  Layer.provide(NoEgressLayer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const expectRegistryUnavailable = <A>(
  effect: Effect.Effect<A, AcpRegistrySupport.AcpRegistryError>,
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    assert.strictEqual(error.reason, "registry_unavailable");
  });

// [fork:lockdown] Tripwire, invariant 2: the live catalog refuses every registry operation
// without a request or a spawn, while an operator-installed local command still resolves.
it.layer(CatalogLayer)("ACP Registry lockdown", (it) => {
  it.effect("refuses registry operations without touching the network", () =>
    Effect.gen(function* () {
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      yield* expectRegistryUnavailable(catalog.search({ query: "devin" }));
      yield* expectRegistryUnavailable(catalog.prepare(prepareInput));
      yield* expectRegistryUnavailable(catalog.inspect(registrySettings));
      yield* expectRegistryUnavailable(catalog.resolve(registrySettings, process.cwd()));
    }),
  );

  it.effect("still resolves an operator-installed local command", () =>
    Effect.gen(function* () {
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const resolved = yield* catalog.resolve(localSettings, process.cwd());
      assert.strictEqual(resolved.distribution, "local");
      assert.strictEqual(resolved.spawn.command, process.execPath);
    }),
  );
});
