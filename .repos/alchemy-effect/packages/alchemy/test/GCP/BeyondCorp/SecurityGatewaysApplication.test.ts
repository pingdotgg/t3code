import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  beyondcorp.getProjectsLocationsSecurityGatewaysApplications({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSecurityGatewaysApplications on a missing application fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.getProjectsLocationsSecurityGatewaysApplications({
          name: `projects/${project}/locations/global/securityGateways/alchemy-missing-sg/applications/alchemy-missing-app`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsSecurityGatewaysApplications without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        beyondcorp.createProjectsLocationsSecurityGatewaysApplications({
          parent: `projects/${project}/locations/global/securityGateways/alchemy-missing-sg`,
          applicationId: "alch-probe-app",
          body: {
            displayName: "probe",
            endpointMatchers: [{ hostname: "example.com", ports: [443] }],
          },
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a security gateway application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* GCP.BeyondCorp.SecurityGateway("Pep", {
            location: "global",
            displayName: "app parent",
          });
          return yield* GCP.BeyondCorp.SecurityGatewaysApplication("Web", {
            securityGateway: gateway.name,
            endpointMatchers: [{ hostname: "app.example.com", ports: [443] }],
            displayName: "app a",
          });
        }),
      );

      expect(created.name).toContain("/applications/");
      expect(created.location).toEqual("global");
      expect(created.endpointMatchers[0]?.hostname).toEqual("app.example.com");
      expect(created.displayName).toEqual("app a");

      const fetched =
        yield* beyondcorp.getProjectsLocationsSecurityGatewaysApplications({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("app a");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* GCP.BeyondCorp.SecurityGateway("Pep", {
            securityGatewayId: created.securityGateway.split("/").pop(),
            location: "global",
            displayName: "app parent",
          });
          return yield* GCP.BeyondCorp.SecurityGatewaysApplication("Web", {
            securityGateway: gateway.name,
            applicationId: created.applicationId,
            endpointMatchers: [
              { hostname: "app.example.com", ports: [80, 443] },
            ],
            displayName: "app b",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("app b");
      expect(updated.endpointMatchers[0]?.ports).toEqual(
        expect.arrayContaining([80, 443]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:beyondcorp", "live"],
    timeout: 120_000,
  },
);
