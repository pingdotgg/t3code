import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as managedidentities from "@distilled.cloud/gcp/managedidentities_v1";
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

// Domain peering is cross-project only. Same-project create returns
// `BadRequest` ("DomainPeering should be used when network and domain
// resource belong to different projects"). Full lifecycle needs a
// domain in another project via GCP_TEST_MANAGEDIDENTITIES_DOMAIN.
const runLifecycle =
  !process.env.FAST &&
  process.env.GCP_TEST_MANAGEDIDENTITIES === "1" &&
  !!process.env.GCP_TEST_MANAGEDIDENTITIES_DOMAIN;
const foreignDomain = process.env.GCP_TEST_MANAGEDIDENTITIES_DOMAIN ?? "";

const waitUntilGone = (name: string) =>
  managedidentities.getProjectsLocationsGlobalPeerings({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsGlobalPeerings on a missing peering fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        managedidentities.getProjectsLocationsGlobalPeerings({
          name: `projects/${project}/locations/global/peerings/alchemy-peering-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:managedidentities", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "a same-project peering is rejected with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingDomain = `projects/${project}/locations/global/domains/missing.alch.test`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.ManagedIdentities.Peering("Spoke", {
              domainResource: missingDomain,
              authorizedNetwork: "default",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("BadRequest");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:managedidentities", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a domain peering",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ManagedIdentities.Peering("Spoke", {
            domainResource: foreignDomain,
            authorizedNetwork: "default",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/peerings/");
      expect(created.peeringId).toEqual(expect.any(String));
      expect(created.domainResource).toEqual(foreignDomain);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* managedidentities.getProjectsLocationsGlobalPeerings({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ManagedIdentities.Peering("Spoke", {
            peeringId: created.peeringId,
            domainResource: foreignDomain,
            authorizedNetwork: "default",
            labels: { env: "prod", role: "peering" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "peering",
      });

      const refetched =
        yield* managedidentities.getProjectsLocationsGlobalPeerings({
          name: created.name,
        });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("peering");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:managedidentities", "live"],
    timeout: 240_000,
  },
);
