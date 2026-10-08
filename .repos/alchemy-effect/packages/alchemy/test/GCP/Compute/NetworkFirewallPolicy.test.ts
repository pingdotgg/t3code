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

const waitUntilGone = (project: string, firewallPolicy: string) =>
  compute.getNetworkFirewallPolicies({ project, firewallPolicy }).pipe(
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
  "getNetworkFirewallPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.getNetworkFirewallPolicies({
          project,
          firewallPolicy: "alchemy-missing-nfw",
        }),
      );
      expect(error._tag).toBe("NotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, replace, and delete a network firewall policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkFirewallPolicy("VpcFw", {
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

      expect(created.networkFirewallPolicyName).toEqual(expect.any(String));
      expect(created.policyType).toEqual("VPC_POLICY");
      expect(created.description).toEqual("allow internal http");
      expect(ruleAt(created.rules, 1000)?.action).toEqual("allow");
      expect(hasReservedGotoNext(created.rules)).toEqual(true);

      const fetched = yield* compute.getNetworkFirewallPolicies({
        project: created.project,
        firewallPolicy: created.networkFirewallPolicyName,
      });
      expect(fetched.name).toEqual(created.networkFirewallPolicyName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("allow internal http");
      expect(ruleAt(fetched.rules, 1000)?.match?.srcIpRanges).toEqual(
        expect.arrayContaining(["10.0.0.0/8"]),
      );

      const listed = yield* compute.listNetworkFirewallPolicies({
        project: created.project,
        maxResults: 500,
      });
      expect(
        (listed.items ?? []).some(
          (policy) => policy.name === created.networkFirewallPolicyName,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkFirewallPolicy("VpcFw", {
            networkFirewallPolicyName: created.networkFirewallPolicyName,
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

      expect(updated.networkFirewallPolicyName).toEqual(
        created.networkFirewallPolicyName,
      );
      expect(updated.networkFirewallPolicyId).toEqual(
        created.networkFirewallPolicyId,
      );
      expect(updated.description).toEqual("updated vpc fw");
      expect(
        ruleAt(updated.rules, 1000)?.match?.srcIpRanges?.slice().sort(),
      ).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);

      const fetchedUpdate = yield* compute.getNetworkFirewallPolicies({
        project: updated.project,
        firewallPolicy: updated.networkFirewallPolicyName,
      });
      expect(fetchedUpdate.description).toContain("updated vpc fw");
      expect(ruleAt(fetchedUpdate.rules, 1000)?.description).toEqual(
        "http and https",
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkFirewallPolicy("VpcFw", {
            networkFirewallPolicyName: nextName(
              created.networkFirewallPolicyName,
            ),
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

      expect(replaced.networkFirewallPolicyName).toEqual(
        nextName(created.networkFirewallPolicyName),
      );
      expect(replaced.networkFirewallPolicyId).not.toEqual(
        created.networkFirewallPolicyId,
      );
      expect(replaced.description).toEqual("replaced vpc fw");
      expect(ruleAt(replaced.rules, 1000)?.action).toEqual("deny");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.project,
        replaced.networkFirewallPolicyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
