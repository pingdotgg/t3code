import * as AWS from "@/AWS";
import { SecurityGroup, SecurityGroupRule, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Schedule from "effect/Schedule";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertSecurityGroupGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "list enumerates the deployed Security Group Rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vpc, sg, rule } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListSgrVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const sg = yield* SecurityGroup("ListSgrSg", {
            vpcId: vpc.vpcId,
          });
          const rule = yield* SecurityGroupRule("ListSgr", {
            groupId: sg.groupId,
            type: "ingress",
            ipProtocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrIpv4: "10.0.0.0/16",
          });
          return { vpc, sg, rule };
        }),
      );

      // Modification requires canonical CIDRs; authorization normalizes them.
      const rejection = yield* EC2.modifySecurityGroupRules({
        GroupId: sg.groupId,
        SecurityGroupRules: [
          {
            SecurityGroupRuleId: rule.securityGroupRuleId,
            SecurityGroupRule: {
              IpProtocol: "tcp",
              FromPort: 443,
              ToPort: 443,
              CidrIpv4: "10.0.0.7/16",
            },
          },
        ],
      }).pipe(
        Effect.as(undefined),
        Effect.catchTag("InvalidParameterValue", (error) =>
          Effect.succeed(error),
        ),
      );
      expect(rejection?._tag).toBe("InvalidParameterValue");
      expect(rejection?.message).toBe(
        "CIDR block 10.0.0.7/16 is not in canonical form",
      );

      const provider = yield* Provider.findProvider(SecurityGroupRule);
      const all = yield* provider.list();

      expect(
        all.some((x) => x.securityGroupRuleId === rule.securityGroupRuleId),
      ).toBe(true);

      yield* stack.destroy();

      // The rule dies with its security group; group + VPC gone proves full
      // teardown.
      yield* assertSecurityGroupGone(sg.groupId);
      yield* assertVpcGone(vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"] },
);

for (const type of ["ingress", "egress"] as const) {
  test.provider(
    `repairs standalone ${type} rule drift with unchanged inputs`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (description?: string) =>
          Effect.gen(function* () {
            const vpc = yield* Vpc("DriftVpc", { cidrBlock: "10.0.0.0/16" });
            const sg = yield* SecurityGroup("DriftSg", {
              vpcId: vpc.vpcId,
              egress: [],
            });
            const rule = yield* SecurityGroupRule("DriftRule", {
              groupId: sg.groupId,
              type,
              ipProtocol: "6",
              fromPort: 443,
              toPort: 443,
              cidrIpv4: "10.0.0.7/16",
              description,
              tags: { purpose: "managed" },
            });
            return { sg, vpc, rule };
          });
        const desired = program("managed rule");
        const { sg, vpc, rule } = yield* stack.deploy(desired);
        const readRule = EC2.describeSecurityGroupRules({
          SecurityGroupRuleIds: [rule.securityGroupRuleId],
        }).pipe(Effect.map((result) => result.SecurityGroupRules![0]!));
        expect((yield* stack.plan(desired)).resources.DriftRule?.action).toBe(
          "noop",
        );
        const rogue = yield* EC2.authorizeSecurityGroupIngress({
          GroupId: sg.groupId,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: 22,
              ToPort: 22,
              IpRanges: [{ CidrIp: "0.0.0.0/0" }],
            },
          ],
        });
        const rogueId = rogue.SecurityGroupRules![0]!.SecurityGroupRuleId!;
        yield* EC2.deleteTags({
          Resources: [rule.securityGroupRuleId],
          Tags: [{ Key: "alchemy::id" }],
        });
        yield* EC2.createTags({
          Resources: [rule.securityGroupRuleId],
          Tags: [{ Key: "purpose", Value: "external" }],
        });
        for (const drift of [
          {
            IpProtocol: "udp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.0.0.0/16",
          },
          {
            IpProtocol: "tcp",
            FromPort: 8443,
            ToPort: 8443,
            CidrIpv4: "10.0.0.0/16",
          },
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "0.0.0.0/0",
          },
        ]) {
          yield* EC2.modifySecurityGroupRules({
            GroupId: sg.groupId,
            SecurityGroupRules: [
              {
                SecurityGroupRuleId: rule.securityGroupRuleId,
                SecurityGroupRule: { ...drift, Description: "managed rule" },
              },
            ],
          });
          const observed = yield* readRule.pipe(
            Effect.repeat({
              until: (value) =>
                value.IpProtocol === drift.IpProtocol &&
                value.FromPort === drift.FromPort &&
                value.CidrIpv4 === drift.CidrIpv4,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
          expect(observed.IpProtocol).toBe(drift.IpProtocol);
          expect(observed.FromPort).toBe(drift.FromPort);
          expect(observed.CidrIpv4).toBe(drift.CidrIpv4);
          expect(observed.Description).toBe("managed rule");
          expect((yield* stack.plan(desired)).resources.DriftRule?.action).toBe(
            "update",
          );
          const repaired = yield* stack.deploy(desired);
          expect(repaired.rule.securityGroupRuleId).toBe(
            rule.securityGroupRuleId,
          );
          const actual = yield* readRule;
          expect(actual.IpProtocol).toBe("tcp");
          expect(actual.FromPort).toBe(443);
          expect(actual.ToPort).toBe(443);
          expect(actual.CidrIpv4).toBe("10.0.0.0/16");
          expect(actual.Description).toBe("managed rule");
          expect(actual.Tags?.find((tag) => tag.Key === "purpose")?.Value).toBe(
            "managed",
          );
          expect(
            actual.Tags?.find((tag) => tag.Key === "alchemy::id")?.Value,
          ).toBe("DriftRule");
          expect((yield* stack.plan(desired)).resources.DriftRule?.action).toBe(
            "noop",
          );
        }
        const groupRules = (yield* EC2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [sg.groupId] }],
        })).SecurityGroupRules!;
        expect(
          groupRules.some((value) => value.SecurityGroupRuleId === rogueId),
        ).toBe(false);
        expect(
          groupRules.some(
            (value) => value.SecurityGroupRuleId === rule.securityGroupRuleId,
          ),
        ).toBe(true);
        yield* stack.deploy(program());
        expect((yield* readRule).Description ?? "").toBe("");
        expect((yield* stack.plan(program())).resources.DriftRule?.action).toBe(
          "noop",
        );
        yield* stack.destroy();
        const absent = yield* EC2.describeSecurityGroupRules({
          SecurityGroupRuleIds: [rule.securityGroupRuleId],
        }).pipe(
          Effect.as(false),
          Effect.catchTag("InvalidSecurityGroupRuleId.NotFound", () =>
            Effect.succeed(true),
          ),
          Effect.repeat({
            until: Boolean,
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        );
        expect(absent).toBe(true);
        yield* assertSecurityGroupGone(sg.groupId);
        yield* assertVpcGone(vpc.vpcId);
      }),
    { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
  );
}
