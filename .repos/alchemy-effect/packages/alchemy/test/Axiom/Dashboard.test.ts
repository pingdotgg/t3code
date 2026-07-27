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
// failure mode without creds is a `ConfigError`:
//   "Axiom env credentials not found. Set AXIOM_TOKEN (or AXIOM_API_KEY)."
const hasAxiomCreds = !!(process.env.AXIOM_TOKEN || process.env.AXIOM_API_KEY);

// Minimal, deterministic dashboard document. `owner: ""` is required when
// authenticating with an API token (Axiom rewrites it to the org-shared
// X-AXIOM-EVERYONE); relative windows use the `qr-now-*` form.
const dashboardProps = {
  dashboard: {
    name: "Alchemy List Test",
    owner: "",
    description: "list() lifecycle test dashboard",
    charts: [],
    layout: [],
    refreshTime: 60,
    schemaVersion: 2,
    timeWindowStart: "qr-now-1h",
    timeWindowEnd: "qr-now",
  },
} as const;

test.provider.skipIf(!hasAxiomCreds)(
  "list enumerates the deployed dashboard",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("ListDashboard", dashboardProps);
        }),
      );

      const provider = yield* Provider.findProvider(Axiom.Dashboard);
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((d) => d.uid === deployed.uid)).toBe(true);

      const found = all.find((d) => d.uid === deployed.uid);
      expect(found?.id).toEqual(deployed.id);
      expect(found?.dashboard.name).toEqual("Alchemy List Test");

      yield* stack.destroy();
    }).pipe(logLevel),
);
