// Relative import (not `@/` alias) so this file runs under both Bun and Node
// without a paths-aware loader. This fixture is excluded from the test
// project's typecheck (see tsconfig.test.json) because the relative path
// crosses composite-project boundaries.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { launch } from "../../../src/Local/RpcServer.ts";

/**
 * `RpcServer.launch` fixture that keeps printing on both stdio channels
 * after boot, so tests can assert the spawner's log hub forwards sidecar
 * output to `/logs` subscribers.
 */
export class TestNoise extends Context.Service<
  TestNoise,
  { echo: (msg: string) => Effect.Effect<string> }
>()("Test.Noise") {}

const TestNoiseLive = Layer.succeed(TestNoise, {
  echo: (msg) => Effect.succeed(`echo:${msg}`),
});

launch(TestNoiseLive);

setInterval(() => {
  console.log("fixture-stdout-ping");
  console.error("fixture-stderr-ping");
}, 100);
