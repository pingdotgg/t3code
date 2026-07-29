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

// Deterministic token name (no Date.now) so reruns target the same token and
// the start/end destroy bookends keep the org clean.
const TOKEN_NAME = "alchemy-list-test-token";

test.provider.skipIf(!hasAxiomCreds)(
  "list enumerates the deployed api token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.ApiToken("ListApiToken", {
            name: TOKEN_NAME,
            description: "alchemy list() lifecycle op test",
            // Axiom rejects a token with no capabilities ("at least one
            // capability must be set"). An org-level read scope is the
            // simplest valid grant that needs no pre-existing dataset.
            orgCapabilities: { datasets: ["read"] },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Axiom.ApiToken);
      const all = yield* provider.list();

      // `getAPITokens` returns the full account-wide list in one shot; the
      // freshly created token must be present, hydrated into the exact `read`
      // Attributes shape (so `.id` / `.name` are directly usable by `delete`).
      expect(all.some((t) => t.id === deployed.id)).toBe(true);

      const row = all.find((t) => t.id === deployed.id)!;
      expect(row.name).toEqual(TOKEN_NAME);
      // The bearer secret is only returned at creation and is never echoed back
      // on enumeration, so `list()` surfaces an empty Redacted token (matching
      // the fact that `read` would only source it from cached state).
      expect(row.token).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
