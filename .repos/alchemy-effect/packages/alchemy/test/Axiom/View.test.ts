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

// Deterministic names (no Date.now) so reruns target the same view/dataset and
// the start/end destroy bookends keep the org clean. A view's APL query is
// validated against existing datasets on create, so we stand up a backing
// dataset in the same stack.
const VIEW_NAME = "alchemy-list-test-view";
const DATASET_NAME = "alchemy-list-test-view-dataset";

test.provider.skipIf(!hasAxiomCreds)(
  "list enumerates the deployed view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Axiom.Dataset("ListViewDataset", {
            name: DATASET_NAME,
          });
          return yield* Axiom.View("ListView", {
            name: VIEW_NAME,
            description: "alchemy list() lifecycle op test",
            datasets: [dataset.name],
            aplQuery: `['${DATASET_NAME}'] | take 1`,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Axiom.View);
      const all = yield* provider.list();

      // `getViews` returns the full account-wide list in one shot; the freshly
      // created view must be present, hydrated into the exact `read` Attributes
      // shape (so `.id` / `.name` are directly usable by `delete`).
      expect(all.some((v) => v.id === deployed.id)).toBe(true);

      const row = all.find((v) => v.id === deployed.id)!;
      expect(row.name).toEqual(VIEW_NAME);
      expect(row.aplQuery).toEqual(deployed.aplQuery);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
