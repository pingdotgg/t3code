import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  networkservices.getProjectsLocationsEndpointPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const matcher = (value: string) => ({
  metadataLabelMatcher: {
    metadataLabelMatchCriteria: "MATCH_ANY" as const,
    metadataLabels: [{ labelName: "app", labelValue: value }],
  },
});

test.provider(
  "getProjectsLocationsEndpointPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsEndpointPolicies({
          name: `projects/${project}/locations/global/endpointPolicies/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete an endpoint policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.EndpointPolicy("Sidecar", {
            location: "global",
            type: "SIDECAR_PROXY",
            description: "endpoint policy a",
            labels: { env: "test" },
            endpointMatcher: matcher("web"),
            trafficPortSelector: { ports: ["8080"] },
          });
        }),
      );

      expect(created.name).toContain("/endpointPolicies/");
      expect(created.endpointPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.type).toEqual("SIDECAR_PROXY");
      expect(created.description).toEqual("endpoint policy a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkservices.getProjectsLocationsEndpointPolicies({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("endpoint policy a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.EndpointPolicy("Sidecar", {
            endpointPolicyId: created.endpointPolicyId,
            location: "global",
            type: "SIDECAR_PROXY",
            description: "endpoint policy b",
            labels: { env: "prod", role: "sidecar" },
            endpointMatcher: matcher("api"),
            trafficPortSelector: { ports: ["8081"] },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("endpoint policy b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "sidecar" });

      const refetched =
        yield* networkservices.getProjectsLocationsEndpointPolicies({
          name: created.name,
        });
      expect(refetched.description).toEqual("endpoint policy b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("sidecar");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);
