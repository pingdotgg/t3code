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

const region = "us-central1";

const waitUntilGone = (project: string, securityPolicy: string) =>
  compute.getRegionSecurityPolicies({ project, region, securityPolicy }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const ruleAt = (
  rules: compute.SecurityPolicyRule[] | undefined,
  priority: number,
) => (rules ?? []).find((rule) => rule.priority === priority);

test.provider(
  "create, update, and delete a regional security policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionSecurityPolicy("Armor", {
            region,
            description: "deny scanner",
            labels: { env: "test" },
            rules: [
              {
                action: "deny(403)",
                priority: 1000,
                description: "block scanner",
                match: {
                  versionedExpr: "SRC_IPS_V1",
                  config: { srcIpRanges: ["9.9.9.0/24"] },
                },
              },
            ],
          });
        }),
      );

      expect(created.securityPolicyName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.type).toEqual("CLOUD_ARMOR");
      expect(created.description).toEqual("deny scanner");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(ruleAt(created.rules, 1000)?.action).toEqual("deny(403)");
      expect(ruleAt(created.rules, 2147483647)?.action).toEqual("allow");

      const fetched = yield* compute.getRegionSecurityPolicies({
        project: created.project,
        region,
        securityPolicy: created.securityPolicyName,
      });
      expect(fetched.name).toEqual(created.securityPolicyName);
      expect(fetched.type).toEqual("CLOUD_ARMOR");
      expect(fetched.description).toEqual("deny scanner");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(ruleAt(fetched.rules, 1000)?.match?.config?.srcIpRanges).toEqual(
        expect.arrayContaining(["9.9.9.0/24"]),
      );

      const listed = yield* compute.listRegionSecurityPolicies({
        project: created.project,
        region,
        filter: "labels.alchemy-id:*",
        maxResults: 500,
      });
      expect(
        (listed.items ?? []).some(
          (policy) => policy.name === created.securityPolicyName,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionSecurityPolicy("Armor", {
            securityPolicyName: created.securityPolicyName,
            region,
            description: "updated armor",
            labels: { env: "prod", role: "waf" },
            advancedOptionsConfig: {
              jsonParsing: "STANDARD",
              logLevel: "VERBOSE",
            },
            rules: [
              {
                action: "deny(403)",
                priority: 1000,
                description: "block scanners",
                match: {
                  versionedExpr: "SRC_IPS_V1",
                  config: { srcIpRanges: ["9.9.9.0/24", "8.8.8.8/32"] },
                },
              },
              {
                action: "allow",
                priority: 2147483647,
                match: {
                  versionedExpr: "SRC_IPS_V1",
                  config: { srcIpRanges: ["*"] },
                },
              },
            ],
          });
        }),
      );

      expect(updated.securityPolicyName).toEqual(created.securityPolicyName);
      expect(updated.securityPolicyId).toEqual(created.securityPolicyId);
      expect(updated.description).toEqual("updated armor");
      expect(updated.labels).toMatchObject({ env: "prod", role: "waf" });
      expect(updated.advancedOptionsConfig?.jsonParsing).toEqual("STANDARD");
      expect(updated.advancedOptionsConfig?.logLevel).toEqual("VERBOSE");
      expect(
        ruleAt(updated.rules, 1000)?.match?.config?.srcIpRanges?.sort(),
      ).toEqual(["8.8.8.8/32", "9.9.9.0/24"]);

      const fetchedUpdate = yield* compute.getRegionSecurityPolicies({
        project: updated.project,
        region,
        securityPolicy: updated.securityPolicyName,
      });
      expect(fetchedUpdate.description).toEqual("updated armor");
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("waf");
      expect(fetchedUpdate.advancedOptionsConfig?.jsonParsing).toEqual(
        "STANDARD",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.securityPolicyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
