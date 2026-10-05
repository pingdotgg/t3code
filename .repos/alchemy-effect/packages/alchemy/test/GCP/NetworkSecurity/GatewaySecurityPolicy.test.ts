import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  networksecurity.getProjectsLocationsGatewaySecurityPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsGatewaySecurityPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsGatewaySecurityPolicies({
          name: `projects/${project}/locations/us-central1/gatewaySecurityPolicies/alchemy-missing`,
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

test.provider(
  "create, update, and delete a gateway security policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.GatewaySecurityPolicy("Swp", {
            location: "us-central1",
            description: "gateway policy a",
          });
        }),
      );

      expect(created.name).toContain("/gatewaySecurityPolicies/");
      expect(created.gatewaySecurityPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("gateway policy a");
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsGatewaySecurityPolicies({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("gateway policy a");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.GatewaySecurityPolicy("Swp", {
            gatewaySecurityPolicyId: created.gatewaySecurityPolicyId,
            location: "us-central1",
            description: "gateway policy b",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("gateway policy b");

      const refetched =
        yield* networksecurity.getProjectsLocationsGatewaySecurityPolicies({
          name: created.name,
        });
      expect(refetched.description).toContain("gateway policy b");
      expect(refetched.description).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
