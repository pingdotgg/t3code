import * as AWS from "@/AWS";
import { RuleGroup } from "@/AWS/NetworkFirewall";
import * as Test from "@/Test/Alchemy";
import * as nfw from "@distilled.cloud/aws/network-firewall";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeRuleGroup on a nonexistent rule group fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        nfw.describeRuleGroup({
          RuleGroupName: "alchemy-nonexistent-nfw-rulegroup-probe",
          Type: "STATEFUL",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const suricataV1 =
  'pass tcp any any -> any 80 (msg:"allow http"; sid:100001; rev:1;)';
const suricataV2 =
  'drop tcp any any -> any 23 (msg:"block telnet"; sid:100002; rev:1;)';

const statelessRuleGroup: nfw.RuleGroup = {
  RulesSource: {
    StatelessRulesAndCustomActions: {
      StatelessRules: [
        {
          Priority: 1,
          RuleDefinition: {
            Actions: ["aws:pass"],
            MatchAttributes: {
              Sources: [{ AddressDefinition: "0.0.0.0/0" }],
              Destinations: [{ AddressDefinition: "0.0.0.0/0" }],
              Protocols: [6],
              DestinationPorts: [{ FromPort: 80, ToPort: 80 }],
            },
          },
        },
      ],
    },
  },
};

// Deletion transitions through a DELETING status before the rule group
// disappears — poll (bounded) until describe returns the typed not-found
// tag. Throttled polls count as "still waiting".
const assertRuleGroupGone = (arn: string) =>
  Effect.gen(function* () {
    const status = yield* nfw.describeRuleGroup({ RuleGroupArn: arn }).pipe(
      Effect.map(
        (r) => r.RuleGroupResponse.RuleGroupStatus ?? ("UNKNOWN" as const),
      ),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
      Effect.catchTag("ThrottlingException", () =>
        Effect.succeed("THROTTLED" as const),
      ),
    );
    if (status !== "gone" && status !== "DELETING") {
      yield* Effect.log(`rule group '${arn}' status: ${status}`);
    }
    if (status !== "gone") {
      return yield* Effect.fail(
        new Error(`rule group '${arn}' still exists (status: ${status})`),
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
  "create, update, and delete stateless + stateful rule groups",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (rules: string, description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const stateless = yield* RuleGroup("Stateless", {
              type: "STATELESS",
              capacity: 10,
              ruleGroup: statelessRuleGroup,
              tags: { fixture: "nfw-rulegroup" },
            });
            const stateful = yield* RuleGroup("Stateful", {
              type: "STATEFUL",
              capacity: 100,
              rules,
              description,
            });
            return { stateless, stateful };
          }),
        );

      const { stateless, stateful } = yield* deploy(suricataV1, "v1");

      expect(stateless.ruleGroupArn).toContain(":stateless-rulegroup/");
      expect(stateless.type).toBe("STATELESS");
      expect(stateless.capacity).toBe(10);
      expect(stateful.ruleGroupArn).toContain(":stateful-rulegroup/");
      expect(stateful.type).toBe("STATEFUL");

      // Out-of-band verification via distilled.
      const observed = yield* nfw.describeRuleGroup({
        RuleGroupArn: stateful.ruleGroupArn,
      });
      expect(observed.RuleGroupResponse.RuleGroupStatus).toBe("ACTIVE");
      expect(observed.RuleGroup?.RulesSource?.RulesString).toBe(suricataV1);
      expect(observed.RuleGroupResponse.Description).toBe("v1");

      // Update in place — same ARN, new rules + description.
      const updated = yield* deploy(suricataV2, "v2");
      expect(updated.stateful.ruleGroupArn).toBe(stateful.ruleGroupArn);
      expect(updated.stateless.ruleGroupArn).toBe(stateless.ruleGroupArn);
      const reobserved = yield* nfw.describeRuleGroup({
        RuleGroupArn: stateful.ruleGroupArn,
      });
      expect(reobserved.RuleGroup?.RulesSource?.RulesString).toBe(suricataV2);
      expect(reobserved.RuleGroupResponse.Description).toBe("v2");

      // Internal + user tags landed on the cloud resource.
      const tags = Object.fromEntries(
        (yield* nfw.listTagsForResource({
          ResourceArn: stateless.ruleGroupArn,
        })).Tags?.map((t) => [t.Key, t.Value]) ?? [],
      );
      expect(tags.fixture).toBe("nfw-rulegroup");

      yield* stack.destroy();
      yield* assertRuleGroupGone(stateless.ruleGroupArn);
      yield* assertRuleGroupGone(stateful.ruleGroupArn);
    }),
  { timeout: 240_000 },
);

test.provider(
  "changing capacity replaces the rule group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (capacity: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const group = yield* RuleGroup("Replaceable", {
              type: "STATEFUL",
              capacity,
              rules: suricataV1,
            });
            return { group };
          }),
        );

      const first = yield* deploy(50);
      const second = yield* deploy(60);

      // Capacity is create-only — the engine must have provisioned a new
      // physical rule group (new instance-suffixed name, new ARN).
      expect(second.group.ruleGroupArn).not.toBe(first.group.ruleGroupArn);
      expect(second.group.capacity).toBe(60);

      const observed = yield* nfw.describeRuleGroup({
        RuleGroupArn: second.group.ruleGroupArn,
      });
      expect(observed.RuleGroupResponse.Capacity).toBe(60);

      yield* stack.destroy();
      yield* assertRuleGroupGone(second.group.ruleGroupArn);
    }),
  { timeout: 240_000 },
);
