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
  networksecurity
    .getProjectsLocationsGatewaySecurityPoliciesRules({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsGatewaySecurityPoliciesRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsGatewaySecurityPoliciesRules({
          name: `projects/${project}/locations/us-central1/gatewaySecurityPolicies/alchemy-missing/rules/missing`,
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
  "create, update, and delete a gateway security policy rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.NetworkSecurity.GatewaySecurityPolicy(
            "Swp",
            {
              location: "us-central1",
              description: "rule parent",
            },
          );
          const rule = yield* GCP.NetworkSecurity.GatewaySecurityPoliciesRule(
            "Allow",
            {
              gatewaySecurityPolicy: policy.name,
              location: "us-central1",
              basicProfile: "ALLOW",
              priority: 1000,
              enabled: true,
              sessionMatcher: "true",
              description: "allow all a",
            },
          );
          return { policy, rule };
        }),
      );

      expect(created.rule.name).toContain("/rules/");
      expect(created.rule.gatewaySecurityPolicy).toEqual(created.policy.name);
      expect(created.rule.basicProfile).toEqual("ALLOW");
      expect(created.rule.priority).toEqual(1000);
      expect(created.rule.enabled).toEqual(true);
      expect(created.rule.sessionMatcher).toEqual("true");
      expect(created.rule.description).toEqual("allow all a");

      const fetched =
        yield* networksecurity.getProjectsLocationsGatewaySecurityPoliciesRules(
          {
            name: created.rule.name,
          },
        );
      expect(fetched.name).toEqual(created.rule.name);
      expect(fetched.basicProfile).toEqual("ALLOW");
      expect(fetched.priority).toEqual(1000);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("allow all a");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.NetworkSecurity.GatewaySecurityPolicy(
            "Swp",
            {
              gatewaySecurityPolicyId: created.policy.gatewaySecurityPolicyId,
              location: "us-central1",
              description: "rule parent",
            },
          );
          const rule = yield* GCP.NetworkSecurity.GatewaySecurityPoliciesRule(
            "Allow",
            {
              gatewaySecurityPolicy: policy.name,
              gatewaySecurityPolicyRuleId:
                created.rule.gatewaySecurityPolicyRuleId,
              location: "us-central1",
              basicProfile: "DENY",
              priority: 100,
              enabled: true,
              sessionMatcher: "true",
              description: "deny all b",
            },
          );
          return { policy, rule };
        }),
      );

      expect(updated.rule.name).toEqual(created.rule.name);
      expect(updated.rule.basicProfile).toEqual("DENY");
      expect(updated.rule.priority).toEqual(100);
      expect(updated.rule.description).toEqual("deny all b");

      const refetched =
        yield* networksecurity.getProjectsLocationsGatewaySecurityPoliciesRules(
          {
            name: created.rule.name,
          },
        );
      expect(refetched.basicProfile).toEqual("DENY");
      expect(refetched.priority).toEqual(100);
      expect(refetched.description).toContain("deny all b");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.rule.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
