import * as Axiom from "@/Axiom";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Axiom credentials are resolved via the AuthProvider (env method reads
// AXIOM_TOKEN / AXIOM_API_KEY). When neither is present the suite can't talk
// to the real API, so skipIf-gate the live list test. On an entitled run the
// failure mode without creds is an `AuthError`:
//   "Axiom env credentials not found. Set AXIOM_TOKEN (or AXIOM_API_KEY)."
const hasAxiomCreds = !!(process.env.AXIOM_TOKEN || process.env.AXIOM_API_KEY);

// Deterministic notifier name so re-runs reconcile the same notifier rather
// than piling up duplicates.
const NOTIFIER_NAME = "alchemy-test-notifier-list";

test.provider.skipIf(!hasAxiomCreds)(
  "list enumerates the deployed notifier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Notifier("ListNotifier", {
            name: NOTIFIER_NAME,
            properties: {
              email: { emails: ["sre@example.com"] },
            },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Axiom.Notifier);
      const all = yield* provider.list();

      // `getNotifiers` returns the full account-wide list in one shot; the
      // freshly created notifier must be present, hydrated into the exact
      // `read` shape (so `.id` / `.name` are directly usable by `delete`).
      const found = all.find((n) => n.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(NOTIFIER_NAME);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
