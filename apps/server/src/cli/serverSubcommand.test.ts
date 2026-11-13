import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { serverSubcommand } from "./serverSubcommand.ts";

it.effect.each([false, true])(
  "describes server commands for a standalone executable: %s",
  (isExecutable) =>
    Effect.gen(function* () {
      const environment = { NODE_OPTIONS: "--trace-warnings", CUSTOM: "preserved" };
      const command = yield* serverSubcommand("__document-text", 192).pipe(
        Effect.provideService(HostProcess.ExecutablePath, "/test/runtime"),
        Effect.provideService(HostProcess.IsExecutable, isExecutable),
        Effect.provideService(HostProcess.Environment, environment),
      );
      assert.strictEqual(command.executable, "/test/runtime");
      assert.strictEqual(command.args.at(-1), "__document-text");
      if (isExecutable) assert.deepStrictEqual(command.args, ["__document-text"]);
      else {
        assert.lengthOf(command.args, 2);
        assert.match(command.args[0]!, /\/apps\/server\/src\/bin\.ts$/);
      }
      assert.deepStrictEqual(command.env, {
        ...environment,
        NODE_OPTIONS: "--trace-warnings --max-old-space-size=192",
        ELECTRON_RUN_AS_NODE: "1",
      });
      assert.deepStrictEqual(environment, {
        NODE_OPTIONS: "--trace-warnings",
        CUSTOM: "preserved",
      });
    }),
);
