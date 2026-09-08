// A second, genuinely distinct entry module for RpcSpawner.test.ts: children
// are keyed by serverEntryUrl, so pinning "distinct entries → distinct
// children" needs two separate files that boot the same server shape.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { launch } from "../../../src/Local/RpcServer.ts";

export class TestEchoB extends Context.Service<
  TestEchoB,
  {
    echo: (msg: string) => Effect.Effect<string>;
  }
>()("Test.Echo") {}

const TestEchoBLive = Layer.succeed(TestEchoB, {
  echo: (msg) => Effect.succeed(`echo:${msg}`),
});

launch(TestEchoBLive);
