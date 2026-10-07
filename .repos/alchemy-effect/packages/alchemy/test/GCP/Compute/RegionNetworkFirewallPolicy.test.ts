import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const region = "us-central1";

const waitUntilGone = (project: string, firewallPolicy: string) =>
  compute
    .getRegionNetworkFirewallPolicies({
      project,
      region,
      firewallPolicy,
    })
    .pipe(
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

const hasReservedGotoNext = (rules: compute.FirewallPolicyRule[] | undefined) =>
  (rules ?? []).some(
    (rule) =>
      rule.action === "goto_next" &&
      rule.priority !== undefined &&
      rule.priority >= 2147483548 &&
      rule.priority <= 2147483647,
  );

const nextName = (name: string) => {
  const flip = name.endsWith("x") ? "z" : "x";
  return name.length < 63 ? `${name}${flip}` : `${name.slice(0, -1)}${flip}`;
};

test.provider(
  "getRegionNetworkFirewallPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.getRegionNetworkFirewallPolicies({
          project,
          region,
          firewallPolicy: "alchemy-missing-rnfw",
        }),
      );
      expect(error._tag).toBe("NotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, replace, and delete a regional network firewall policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionNetworkFirewallPolicy("VpcFw", {
            region,
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

      expect(created.firewallPolicyName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.policyType).toEqual("VPC_POLICY");
      expect(created.description).toEqual("allow internal http");
      expect(ruleAt(created.rules, 1000)?.action).toEqual("allow");
      expect(hasReservedGotoNext(created.rules)).toEqual(true);

      const fetched = yield* compute.getRegionNetworkFirewallPolicies({
        project: created.project,
        region,
        firewallPolicy: created.firewallPolicyName,
      });
      expect(fetched.name).toEqual(created.firewallPolicyName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("allow internal http");
      expect(ruleAt(fetched.rules, 1000)?.match?.srcIpRanges).toEqual(
        expect.arrayContaining(["10.0.0.0/8"]),
      );

      const listed = yield* compute.listRegionNetworkFirewallPolicies({
        project: created.project,
        region,
        maxResults: 500,
      });
      expect(
        (listed.items ?? []).some(
          (policy) => policy.name === created.firewallPolicyName,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionNetworkFirewallPolicy("VpcFw", {
            firewallPolicyName: created.firewallPolicyName,
            region,
            description: "updated vpc fw",
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

      expect(updated.firewallPolicyName).toEqual(created.firewallPolicyName);
      expect(updated.firewallPolicyId).toEqual(created.firewallPolicyId);
      expect(updated.description).toEqual("updated vpc fw");
      expect(
        ruleAt(updated.rules, 1000)?.match?.srcIpRanges?.slice().sort(),
      ).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);

      const fetchedUpdate = yield* compute.getRegionNetworkFirewallPolicies({
        project: updated.project,
        region,
        firewallPolicy: updated.firewallPolicyName,
      });
      expect(fetchedUpdate.description).toContain("updated vpc fw");
      expect(ruleAt(fetchedUpdate.rules, 1000)?.description).toEqual(
        "http and https",
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionNetworkFirewallPolicy("VpcFw", {
            firewallPolicyName: nextName(created.firewallPolicyName),
            region,
            description: "replaced vpc fw",
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

      expect(replaced.firewallPolicyName).toEqual(
        nextName(created.firewallPolicyName),
      );
      expect(replaced.firewallPolicyId).not.toEqual(created.firewallPolicyId);
      expect(replaced.description).toEqual("replaced vpc fw");
      expect(ruleAt(replaced.rules, 1000)?.action).toEqual("deny");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.project,
        replaced.firewallPolicyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
