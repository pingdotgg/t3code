import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as CliError from "effect/unstable/cli/CliError";
import { Command } from "effect/unstable/cli";

import { cli } from "./cli.ts";

const provideCliRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(NetService.layer, NodeServices.layer)));

it.layer(NodeServices.layer)("cli log-level parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    Command.runWith(cli, { version: "0.0.0" })(["--log-level", "debug", "--version"]).pipe(
      provideCliRuntime,
    ),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* Command.runWith(cli, { version: "0.0.0" })([
        "--log-level",
        "Debug",
      ]).pipe(provideCliRuntime, Effect.flip);

      if (!CliError.isCliError(error)) {
        throw new Error(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        throw new Error(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );
});
