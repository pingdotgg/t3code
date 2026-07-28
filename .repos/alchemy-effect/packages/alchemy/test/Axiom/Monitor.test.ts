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

// Deterministic names so re-runs reconcile the same resources rather than
// piling up duplicates. The monitor's APL query needs a real dataset target.
const DATASET_NAME = "alchemy-test-monitor-list";
const MONITOR_NAME = "alchemy-test-monitor-list";

test.provider.skipIf(!hasAxiomCreds)(
  "list enumerates the deployed monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Axiom.Dataset("ListDataset", {
            name: DATASET_NAME,
          });
          return yield* Axiom.Monitor("ListMonitor", {
            name: MONITOR_NAME,
            description: "alchemy list() lifecycle op test",
            type: "Threshold",
            aplQuery: `['${DATASET_NAME}'] | summarize count()`,
            intervalMinutes: 5,
            rangeMinutes: 5,
            operator: "Above",
            threshold: 1,
            notifierIds: [],
            alertOnNoData: false,
            resolvable: true,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Axiom.Monitor);
      const all = yield* provider.list();

      // `getMonitors` returns the full account-wide list in one shot; the
      // freshly created monitor must be present, hydrated into the exact `read`
      // Attributes shape (so `.id` / `.type` are directly usable by `delete`).
      const found = all.find((m) => m.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(MONITOR_NAME);
      expect(found?.type).toEqual("Threshold");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
