import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A deterministic destination address used for the list test. Cloudflare
// sends a verification email on first create; the address still shows up in
// the account-scoped list whether or not it has been verified, which is all
// the list() assertion needs.
const testEmail = "alchemy-list-test@alchemy-test-2.us";

// Canonical `list()` test (account-scoped collection): register a real
// destination address, resolve the provider from context via the typed
// `findProvider`, call `list()`, and assert the deployed address appears in
// the exhaustively-paginated result.
test.provider("list enumerates the deployed email address", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const address = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Email.Address("ListAddress", {
          email: testEmail,
        });
      }),
    );

    expect(address.email).toEqual(testEmail);

    const provider = yield* Provider.findProvider(Cloudflare.Email.Address);

    // A freshly-deployed address is eventually consistent in the account-wide
    // list(); poll until it appears before asserting.
    const all = yield* poll({
      description: "list() includes the deployed email address",
      effect: provider.list(),
      predicate: (all) => all.some((a) => a.email === testEmail),
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    });

    expect(all.some((a) => a.addressId === address.addressId)).toBe(true);
    expect(all.some((a) => a.email === testEmail)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);
