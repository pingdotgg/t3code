import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  beyondcorp.getProjectsLocationsAppGateways({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppGateways on a missing gateway fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.getProjectsLocationsAppGateways({
          name: `projects/${project}/locations/us-central1/appGateways/alchemy-missing-gw`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* beyondcorp.listProjectsLocationsAppGateways({
        parent: `projects/${project}/locations/us-central1`,
        pageSize: 10,
      });
      expect((page.appGateways ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/appGateways/alchemy-missing-gw`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsAppGateways without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.createProjectsLocationsAppGateways({
          parent: `projects/${project}/locations/us-central1`,
          appGatewayId: "alch-probe-gw",
          validateOnly: true,
          body: {
            type: "TCP_PROXY",
            hostType: "GCP_REGIONAL_MIG",
          },
        }),
      );
      expect(error._tag).toEqual("AppConnectorsNotImplemented");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an app gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BeyondCorp.AppGateway("Edge", {
            location: "us-central1",
            type: "TCP_PROXY",
            hostType: "GCP_REGIONAL_MIG",
            displayName: "gateway a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/appGateways/");
      expect(created.location).toEqual("us-central1");
      expect(created.type).toEqual("TCP_PROXY");
      expect(created.hostType).toEqual("GCP_REGIONAL_MIG");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* beyondcorp.getProjectsLocationsAppGateways({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BeyondCorp.AppGateway("Edge", {
            appGatewayId: created.appGatewayId,
            location: "us-central1",
            type: "TCP_PROXY",
            hostType: "GCP_REGIONAL_MIG",
            displayName: "gateway b",
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.appGatewayId).toEqual(created.appGatewayId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 120_000,
  },
);
