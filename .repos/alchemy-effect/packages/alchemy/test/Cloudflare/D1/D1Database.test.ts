import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Canonical `list()` test (account-scoped collection): deploy a real D1
// database, resolve the provider from context via the typed
// `Provider.findProvider`, call `list()`, and assert the deployed database
// appears in the exhaustively-paginated result.
test.provider("list enumerates the deployed database", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const database = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("ListDatabase");
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.D1.Database);
    const all = yield* provider.list();

    expect(all.some((db) => db.databaseId === database.databaseId)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);
