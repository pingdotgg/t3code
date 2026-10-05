import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkehub from "@distilled.cloud/gcp/gkehub_v2";
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

const membership = process.env.GCP_TEST_GKE_MEMBERSHIP;
// The full lifecycle needs a registered Fleet membership; set
// GCP_TEST_GKE_MEMBERSHIP to run it.
const runLifecycle = !!membership;

const missingMembershipOf = (project: string) =>
  `projects/${project}/locations/global/memberships/alchemy-missing-membership`;
const missingFeatureOf = (project: string) =>
  `${missingMembershipOf(project)}/features/configmanagement`;

const waitUntilGone = (name: string) =>
  gkehub.getProjectsLocationsMembershipsFeatures({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsMembershipsFeatures on a missing feature fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingFeature = missingFeatureOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkehub.getProjectsLocationsMembershipsFeatures({
          name: missingFeature,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* gkehub.listProjectsLocationsMembershipsFeatures({
        parent: `projects/${project}/locations/global/memberships/-`,
        pageSize: 10,
      });
      expect(
        (page.membershipFeatures ?? []).map((feature) => feature.name),
      ).not.toContain(missingFeature);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkehub", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "create against a missing membership fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingMembership = missingMembershipOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
              membership: missingMembership,
              featureId: "configmanagement",
              spec: {
                configmanagement: {
                  configSync: { enabled: false },
                },
              },
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkehub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a membership feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
            membership: membership!,
            featureId: "configmanagement",
            spec: {
              configmanagement: {
                configSync: { enabled: false },
              },
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/features/");
      expect(created.featureId).toEqual("configmanagement");
      expect(created.membership).toEqual(
        membership!.includes("/")
          ? membership!.replace(/\/+$/, "")
          : expect.stringContaining(`/memberships/${membership}`),
      );
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* gkehub.getProjectsLocationsMembershipsFeatures({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
            membership: created.membership,
            featureId: created.featureId,
            location: created.location,
            spec: {
              configmanagement: {
                configSync: { enabled: false, preventDrift: true },
              },
            },
            labels: { env: "prod", role: "hub" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "hub" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkehub", "live"], timeout: 120_000 },
);
