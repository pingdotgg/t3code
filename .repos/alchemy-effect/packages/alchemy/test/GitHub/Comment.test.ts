import * as GitHub from "@/GitHub";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GitHub.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A GitHub Comment is keyed entirely by its parent {owner, repository,
// issueNumber} plus a server-assigned commentId. GitHub only enumerates
// comments *within* a specific issue/PR — there is no account- or repo-wide
// API to list every comment without first knowing the issue/PR. So the
// provider is non-listable and `list()` returns `[]`.
test.provider(
  "list returns [] for the non-listable Comment provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(GitHub.Comment);
      const all = yield* provider.list();
      expect(all).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
