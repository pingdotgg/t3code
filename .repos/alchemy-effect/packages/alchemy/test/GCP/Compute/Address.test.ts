import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, region: string, addressName: string) =>
  compute.getAddresses({ project, region, address: addressName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a regional address",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Address("Ingress", {
            region: "us-central1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.addressName).toEqual(expect.any(String));
      expect(created.address).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.addressType).toEqual("EXTERNAL");
      expect(created.networkTier).toEqual("PREMIUM");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.status).toEqual(expect.stringMatching(/RESERVED|IN_USE/));

      const fetched = yield* compute.getAddresses({
        project: created.project,
        region: created.region,
        address: created.addressName,
      });
      expect(fetched.name).toEqual(created.addressName);
      expect(fetched.address).toEqual(created.address);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Address("Ingress", {
            addressName: created.addressName,
            region: "us-central1",
            labels: { env: "prod", role: "ingress" },
          });
        }),
      );

      expect(updated.addressName).toEqual(created.addressName);
      expect(updated.address).toEqual(created.address);
      expect(updated.labels).toMatchObject({ env: "prod", role: "ingress" });

      const fetchedUpdated = yield* compute.getAddresses({
        project: updated.project,
        region: updated.region,
        address: updated.addressName,
      });
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("ingress");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.region,
        created.addressName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
