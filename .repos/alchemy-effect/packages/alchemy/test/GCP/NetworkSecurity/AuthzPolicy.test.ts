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

const missingNameOf = (project: string) =>
  `projects/${project}/locations/us-central1/authzPolicies/alchemy-missing-authz-policy`;

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsAuthzPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAuthzPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingName = missingNameOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsAuthzPolicies({
          name: missingName,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createProjectsLocationsAuthzPolicies without a forwarding rule fails with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const forwardingRule = `//compute.googleapis.com/projects/${project}/regions/us-central1/forwardingRules/alchemy-missing-fr`;
      const error = yield* Effect.flip(
        networksecurity.createProjectsLocationsAuthzPolicies({
          parent: `projects/${project}/locations/us-central1`,
          authzPolicyId: "alchemy-missing-authz-policy",
          body: {
            action: "ALLOW",
            target: {
              loadBalancingScheme: "INTERNAL_MANAGED",
              resources: [forwardingRule],
            },
            httpRules: [
              {
                to: {
                  operations: [
                    { methods: ["GET"], paths: [{ prefix: "/admin" }] },
                  ],
                },
              },
            ],
          },
        }),
      );
      expect(error._tag).toBe("BadRequest");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

// Needs an existing application load balancer forwarding rule; set
// GCP_TEST_AUTHZ_POLICY_TARGET to its resource name.
test.provider.skipIf(!process.env.GCP_TEST_AUTHZ_POLICY_TARGET)(
  "create, update, and delete an authz policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const forwardingRule = process.env.GCP_TEST_AUTHZ_POLICY_TARGET!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.AuthzPolicy("AllowAdmin", {
            location: "us-central1",
            action: "ALLOW",
            target: {
              loadBalancingScheme: "INTERNAL_MANAGED",
              resources: [forwardingRule],
            },
            httpRules: [
              {
                to: {
                  operations: [
                    { methods: ["GET"], paths: [{ prefix: "/admin" }] },
                  ],
                },
              },
            ],
            description: "authz a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/authzPolicies/");
      expect(created.location).toEqual("us-central1");
      expect(created.action).toEqual("ALLOW");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* networksecurity.getProjectsLocationsAuthzPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.AuthzPolicy("AllowAdmin", {
            authzPolicyId: created.authzPolicyId,
            location: "us-central1",
            action: "ALLOW",
            target: created.target ?? {
              loadBalancingScheme: "INTERNAL_MANAGED",
              resources: [forwardingRule],
            },
            httpRules: [
              {
                to: {
                  operations: [
                    { methods: ["GET"], paths: [{ prefix: "/admin" }] },
                  ],
                },
              },
            ],
            description: "authz b",
            labels: { env: "prod", role: "authz" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("authz b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "authz" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
