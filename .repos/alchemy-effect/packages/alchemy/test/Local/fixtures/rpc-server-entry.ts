// Relative import (not `@/` alias) so this file runs under both Bun and Node
// without a paths-aware loader. This fixture is excluded from the test
// project's typecheck (see tsconfig.test.json) because the relative path
// crosses composite-project boundaries.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { launch } from "../../../src/Local/RpcServer.ts";

/**
 * Minimal test fixture for `RpcServer.launch`. Registers a single service
 * keyed by `"Test.Echo"` which is what the parent looks up via
 * `getProvider("Test.Echo")`.
 */
export class TestEcho extends Context.Service<
  TestEcho,
  {
    echo: (msg: string) => Effect.Effect<string>;
    boom: () => Effect.Effect<never, { _tag: "Boom"; msg: string }>;
  }
>()("Test.Echo") {}

const TestEchoLive = Layer.succeed(TestEcho, {
  echo: (msg) => Effect.succeed(`echo:${msg}`),
  boom: () => Effect.fail({ _tag: "Boom" as const, msg: "kaboom" }),
});

launch(TestEchoLive);
