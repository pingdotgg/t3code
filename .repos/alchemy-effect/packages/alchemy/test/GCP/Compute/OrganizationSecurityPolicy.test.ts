import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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

const runLifecycle =
  !!process.env.GCP_TEST_ORG_SECURITY_POLICY && !process.env.FAST;

const waitUntilGone = (securityPolicy: string) =>
  compute.getOrganizationSecurityPolicies({ securityPolicy }).pipe(
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
  "getOrganizationSecurityPolicies with an invalid id fails with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getOrganizationSecurityPolicies({
          securityPolicy: "0",
        }),
      );
      expect(error._tag).toEqual("BadRequest");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.GCP_TEST_ORG_SECURITY_POLICY)(
  "insertOrganizationSecurityPolicies without org IAM fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      expect(resource.parent).toEqual(expect.any(String));

      const error = yield* Effect.flip(
        compute.insertOrganizationSecurityPolicies({
          parentId: resource.parent,
          body: {
            shortName: "alchemy-orgarmor-probe",
            description: "probe",
            type: "CLOUD_ARMOR",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an organization security policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.OrganizationSecurityPolicy("OrgArmor", {
            description: "deny scanner",
            rules: [
              {
                action: "deny(403)",
                priority: 1000,
                match: {
                  versionedExpr: "SRC_IPS_V1",
                  config: { srcIpRanges: ["9.9.9.0/24"] },
                },
              },
            ],
          });
        }),
      );

      expect(created.shortName).toEqual(expect.any(String));
      expect(created.securityPolicyId).toEqual(expect.any(String));
      expect(created.type).toEqual("CLOUD_ARMOR");
      expect(created.description).toEqual("deny scanner");
      expect(ruleAt(created.rules, 1000)?.action).toEqual("deny(403)");

      const fetched = yield* compute.getOrganizationSecurityPolicies({
        securityPolicy: created.securityPolicyId,
      });
      expect(fetched.shortName).toEqual(created.shortName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.OrganizationSecurityPolicy("OrgArmor", {
            shortName: created.shortName,
            parent: created.parent,
            description: "updated armor",
            rules: [
              {
                action: "deny(403)",
                priority: 1000,
                match: {
                  versionedExpr: "SRC_IPS_V1",
                  config: { srcIpRanges: ["9.9.9.0/24", "8.8.8.8/32"] },
                },
              },
            ],
          });
        }),
      );

      expect(updated.securityPolicyId).toEqual(created.securityPolicyId);
      expect(updated.description).toEqual("updated armor");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.securityPolicyId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
