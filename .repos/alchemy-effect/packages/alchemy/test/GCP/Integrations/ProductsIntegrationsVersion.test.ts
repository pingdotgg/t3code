import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  integrations.getProjectsLocationsProductsIntegrationsVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const apiTrigger = [
  {
    label: "API Trigger",
    triggerType: "API" as const,
    triggerNumber: "1",
    triggerId: "api_trigger/alchemy_product_orders",
    properties: { "Trigger name": "alchemy_product_orders" },
  },
];

test.provider(
  "getProjectsLocationsProductsIntegrationsVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsProductsIntegrationsVersions({
          name: `projects/${project}/locations/us-central1/products/IP/integrations/alchemy-missing/versions/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a product integration version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsIntegrationsVersion("Orders", {
            location: "us-central1",
            product: "IP",
            description: "order workflow",
            triggerConfigs: apiTrigger,
          });
        }),
      );

      expect(created.name).toContain("/integrations/");
      expect(created.name).toContain("/versions/");
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("order workflow");

      const fetched =
        yield* integrations.getProjectsLocationsProductsIntegrationsVersions({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsIntegrationsVersion("Orders", {
            integrationId: created.integrationId,
            versionId: created.versionId,
            location: "us-central1",
            product: "IP",
            description: "updated workflow",
            triggerConfigs: apiTrigger,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated workflow");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:integrations", "live"],
    timeout: 90_000,
  },
);
