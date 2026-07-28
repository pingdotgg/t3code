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

// Deterministic names (no Date.now) so reruns reconcile the same dataset and
// virtual field rather than piling up duplicates.
const DATASET_NAME = "alchemy-test-virtualfield-list";
const FIELD_NAME = "alchemy_list_status_class";

test.provider.skipIf(!hasAxiomCreds)(
  "list enumerates the deployed virtual field",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Axiom.Dataset("ListDataset", {
            name: DATASET_NAME,
          });
          return yield* Axiom.VirtualField("ListVirtualField", {
            dataset: dataset.name,
            name: FIELD_NAME,
            description: "list() coverage marker",
            expression: 'strcat(tostring(toint(status / 100)), "xx")',
            type: "string",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Axiom.VirtualField);
      const all = yield* provider.list();

      // `getVirtualFields` is per-dataset, so `list()` enumerates every dataset
      // and fans out the per-dataset vfields list; the freshly created field
      // must be present, hydrated into the exact `read` shape (so `.id` /
      // `.dataset` are directly usable by `delete`).
      const found = all.find((vf) => vf.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(FIELD_NAME);
      expect(found?.dataset).toEqual(DATASET_NAME);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
