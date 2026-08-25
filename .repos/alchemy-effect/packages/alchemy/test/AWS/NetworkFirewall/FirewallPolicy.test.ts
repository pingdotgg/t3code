import * as AWS from "@/AWS";
import { FirewallPolicy, RuleGroup } from "@/AWS/NetworkFirewall";
import * as Test from "@/Test/Alchemy";
import * as nfw from "@distilled.cloud/aws/network-firewall";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe.
test.provider(
  "describeFirewallPolicy on a nonexistent policy fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        nfw.describeFirewallPolicy({
          FirewallPolicyName: "alchemy-nonexistent-nfw-policy-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Deletion transitions through a DELETING status before the policy
// disappears — poll (bounded) until describe returns the typed not-found
// tag. Throttled polls count as "still waiting".
const assertPolicyGone = (arn: string) =>
  Effect.gen(function* () {
    const status = yield* nfw
      .describeFirewallPolicy({ FirewallPolicyArn: arn })
      .pipe(
        Effect.map(
          (r) =>
            r.FirewallPolicyResponse.FirewallPolicyStatus ??
            ("UNKNOWN" as const),
        ),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("gone" as const),
        ),
        Effect.catchTag("ThrottlingException", () =>
          Effect.succeed("THROTTLED" as const),
        ),
      );
    if (status !== "gone") {
      return yield* Effect.fail(
        new Error(`firewall policy '${arn}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

test.provider(
  "create, update, and delete a firewall policy referencing a rule group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { stateful, policy } = yield* stack.deploy(
        Effect.gen(function* () {
          const stateful = yield* RuleGroup("Stateful", {
            type: "STATEFUL",
            capacity: 100,
            rules:
              'pass tcp any any -> any 443 (msg:"allow https"; sid:200001; rev:1;)',
          });
          const policy = yield* FirewallPolicy("Policy", {
            firewallPolicy: {
              StatelessDefaultActions: ["aws:forward_to_sfe"],
              StatelessFragmentDefaultActions: ["aws:forward_to_sfe"],
              StatefulRuleGroupReferences: [
                { ResourceArn: stateful.ruleGroupArn },
              ],
            },
            description: "v1",
            tags: { fixture: "nfw-policy" },
          });
          return { stateful, policy };
        }),
      );

      expect(policy.firewallPolicyArn).toContain(":firewall-policy/");
      expect(policy.firewallPolicyId).toBeDefined();

      // Out-of-band verification via distilled.
      const observed = yield* nfw.describeFirewallPolicy({
        FirewallPolicyArn: policy.firewallPolicyArn,
      });
      expect(observed.FirewallPolicyResponse.FirewallPolicyStatus).toBe(
        "ACTIVE",
      );
      expect(
        observed.FirewallPolicy?.StatefulRuleGroupReferences?.[0]?.ResourceArn,
      ).toBe(stateful.ruleGroupArn);
      expect(observed.FirewallPolicyResponse.Description).toBe("v1");

      yield* stack.destroy();
      yield* assertPolicyGone(policy.firewallPolicyArn);
    }),
  { timeout: 240_000 },
);

test.provider(
  "updates the policy definition in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (statelessDefaultActions: string[], description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const policy = yield* FirewallPolicy("PassPolicy", {
              firewallPolicy: {
                StatelessDefaultActions: statelessDefaultActions,
                StatelessFragmentDefaultActions: statelessDefaultActions,
              },
              description,
            });
            return { policy };
          }),
        );

      const first = yield* deploy(["aws:pass"], "pass everything");
      const second = yield* deploy(["aws:drop"], "drop everything");

      // In-place update: same ARN, new definition.
      expect(second.policy.firewallPolicyArn).toBe(
        first.policy.firewallPolicyArn,
      );
      const observed = yield* nfw.describeFirewallPolicy({
        FirewallPolicyArn: second.policy.firewallPolicyArn,
      });
      expect(observed.FirewallPolicy?.StatelessDefaultActions).toEqual([
        "aws:drop",
      ]);
      expect(observed.FirewallPolicyResponse.Description).toBe(
        "drop everything",
      );

      yield* stack.destroy();
      yield* assertPolicyGone(second.policy.firewallPolicyArn);
    }),
  { timeout: 240_000 },
);
