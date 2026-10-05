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
  !!process.env.GCP_TEST_FIREWALL_POLICY && !process.env.FAST;

const waitUntilGone = (firewallPolicy: string) =>
  compute.getFirewallPolicies({ firewallPolicy }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const ruleAt = (
  rules: compute.FirewallPolicyRule[] | undefined,
  priority: number,
) => (rules ?? []).find((rule) => rule.priority === priority);

const nextShortName = (name: string) =>
  name.length < 63 ? `${name}x` : `${name.slice(0, 62)}x`;

test.provider(
  "getFirewallPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getFirewallPolicies({
          firewallPolicy: "0",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.GCP_TEST_FIREWALL_POLICY)(
  "insertFirewallPolicies without org IAM fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      expect(resource.parent).toEqual(expect.any(String));

      const error = yield* Effect.flip(
        compute.insertFirewallPolicies({
          parentId: resource.parent,
          body: {
            shortName: "alchemy-fwpol-probe",
            description: "probe",
          },
        }),
      );
      expect(error._tag).toBe("Forbidden");
      expect(error.message).toContain("compute.firewallPolicies.create");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete a firewall policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.FirewallPolicy("OrgFw", {
            description: "allow internal http",
            rules: [
              {
                action: "allow",
                priority: 1000,
                direction: "INGRESS",
                match: {
                  srcIpRanges: ["10.0.0.0/8"],
                  layer4Configs: [{ ipProtocol: "tcp", ports: ["80"] }],
                },
              },
            ],
          });
        }),
      );

      expect(created.shortName).toEqual(expect.any(String));
      expect(created.firewallPolicyId).toEqual(expect.any(String));
      expect(created.parent).toEqual(
        expect.stringMatching(/^(folders|organizations)\//),
      );
      expect(created.policyType).toEqual("VPC_POLICY");
      expect(created.description).toEqual("allow internal http");
      expect(ruleAt(created.rules, 1000)?.action).toEqual("allow");
      expect(ruleAt(created.rules, 2147483647)?.action).toEqual("goto_next");

      const fetched = yield* compute.getFirewallPolicies({
        firewallPolicy: created.firewallPolicyId,
      });
      expect(fetched.shortName).toEqual(created.shortName);
      expect(fetched.name).toEqual(created.firewallPolicyId);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("allow internal http");
      expect(ruleAt(fetched.rules, 1000)?.match?.srcIpRanges).toEqual(
        expect.arrayContaining(["10.0.0.0/8"]),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.FirewallPolicy("OrgFw", {
            shortName: created.shortName,
            parent: created.parent,
            description: "updated org fw",
            rules: [
              {
                action: "allow",
                priority: 1000,
                direction: "INGRESS",
                description: "http and https",
                match: {
                  srcIpRanges: ["10.0.0.0/8", "192.168.0.0/16"],
                  layer4Configs: [{ ipProtocol: "tcp", ports: ["80", "443"] }],
                },
              },
            ],
          });
        }),
      );

      expect(updated.shortName).toEqual(created.shortName);
      expect(updated.firewallPolicyId).toEqual(created.firewallPolicyId);
      expect(updated.description).toEqual("updated org fw");
      expect(
        ruleAt(updated.rules, 1000)?.match?.srcIpRanges?.slice().sort(),
      ).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);

      const fetchedUpdate = yield* compute.getFirewallPolicies({
        firewallPolicy: updated.firewallPolicyId,
      });
      expect(fetchedUpdate.description).toContain("updated org fw");
      expect(ruleAt(fetchedUpdate.rules, 1000)?.description).toEqual(
        "http and https",
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.FirewallPolicy("OrgFw", {
            shortName: nextShortName(created.shortName),
            parent: created.parent,
            description: "replaced org fw",
            rules: [
              {
                action: "deny",
                priority: 1000,
                direction: "INGRESS",
                match: {
                  srcIpRanges: ["0.0.0.0/0"],
                  layer4Configs: [{ ipProtocol: "tcp", ports: ["23"] }],
                },
              },
            ],
          });
        }),
      );

      expect(replaced.shortName).toEqual(nextShortName(created.shortName));
      expect(replaced.firewallPolicyId).not.toEqual(created.firewallPolicyId);
      expect(replaced.description).toEqual("replaced org fw");
      expect(ruleAt(replaced.rules, 1000)?.action).toEqual("deny");

      const fetchedReplace = yield* compute.getFirewallPolicies({
        firewallPolicy: replaced.firewallPolicyId,
      });
      expect(fetchedReplace.shortName).toEqual(replaced.shortName);
      expect(fetchedReplace.description).toContain("replaced org fw");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.firewallPolicyId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
