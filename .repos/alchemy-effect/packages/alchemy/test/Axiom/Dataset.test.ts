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

// Deterministic dataset name so re-runs reconcile the same dataset rather than
// piling up duplicates (no Date.now in physical names).
const DATASET_NAME = "alchemy-test-dataset-list";

// Canonical `list()` test (account collection): Axiom exposes a single
// org-wide `GET /v2/datasets` op, so `list()` enumerates every dataset and
// hydrates each row into the exact `read` Attributes shape.
test.provider.skipIf(!hasAxiomCreds)(
  "list enumerates the deployed dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("ListDataset", {
            name: DATASET_NAME,
            description: "alchemy list() lifecycle op test",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Axiom.Dataset);
      const all = yield* provider.list();

      // `getDatasets` returns the full account-wide list in one shot; the
      // freshly created dataset must be present, hydrated into the exact
      // `read` shape (so `.id` / `.name` are directly usable by `delete`).
      const found = all.find((d) => d.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(DATASET_NAME);
      expect(found?.kind).toEqual(deployed.kind);
      expect(found?.otelTracesEndpoint).toEqual(deployed.otelTracesEndpoint);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
