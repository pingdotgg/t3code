import { assert, it } from "@effect/vitest";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Cli from "./CodeCommitCli.ts";

it.effect("verifies the account in the write's repository region", () => {
  let writes = 0;
  return Effect.gen(function* () {
    const cli = yield* Cli.make;
    yield* cli.provideConfig(
      cli.execute("/repo", ["codecommit", "update-pull-request-title"], "us-gov-west-1"),
      { profile: "work", region: "us-east-1", accountId: "123456789012" },
    );
    assert.strictEqual(writes, 1);
  }).pipe(
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: ({ args }) => {
            assert.strictEqual(args[args.indexOf("--region") + 1], "us-gov-west-1");
            if (args[0] === "codecommit") writes++;
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                JSON.stringify(args[0] === "sts" ? { Account: "123456789012" } : {}),
              ),
            );
          },
        },
      }),
    ),
  );
});
