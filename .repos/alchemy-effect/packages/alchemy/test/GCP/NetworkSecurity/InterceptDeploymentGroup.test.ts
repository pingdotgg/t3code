import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsInterceptDeploymentGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsInterceptDeploymentGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsInterceptDeploymentGroups({
          name: `projects/${project}/locations/global/interceptDeploymentGroups/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an intercept deployment group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
            description: "intercept group vpc",
          });
          const group = yield* GCP.NetworkSecurity.InterceptDeploymentGroup(
            "Inspect",
            {
              location: "global",
              network: vpc.selfLink.as<string>(),
              description: "intercept group a",
              labels: { env: "test" },
            },
          );
          return { vpc, group };
        }),
      );

      expect(created.group.name).toContain("/interceptDeploymentGroups/");
      expect(created.group.location).toEqual("global");
      expect(created.group.description).toEqual("intercept group a");
      expect(created.group.labels).toMatchObject({ env: "test" });
      expect(created.group.network).toContain(
        `/global/networks/${created.vpc.networkName}`,
      );

      const fetched =
        yield* networksecurity.getProjectsLocationsInterceptDeploymentGroups({
          name: created.group.name,
        });
      expect(fetched.name).toEqual(created.group.name);
      expect(fetched.description).toEqual("intercept group a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* GCP.Compute.Network("Vpc", {
            networkName: created.vpc.networkName,
            autoCreateSubnetworks: false,
            description: "intercept group vpc",
          });
          const group = yield* GCP.NetworkSecurity.InterceptDeploymentGroup(
            "Inspect",
            {
              interceptDeploymentGroupId:
                created.group.interceptDeploymentGroupId,
              location: "global",
              network: vpc.selfLink.as<string>(),
              description: "intercept group b",
              labels: { env: "prod", role: "intercept" },
            },
          );
          return { vpc, group };
        }),
      );

      expect(updated.group.name).toEqual(created.group.name);
      expect(updated.group.description).toEqual("intercept group b");
      expect(updated.group.labels).toMatchObject({
        env: "prod",
        role: "intercept",
      });

      const refetched =
        yield* networksecurity.getProjectsLocationsInterceptDeploymentGroups({
          name: created.group.name,
        });
      expect(refetched.description).toEqual("intercept group b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("intercept");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.group.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 600_000,
  },
);
