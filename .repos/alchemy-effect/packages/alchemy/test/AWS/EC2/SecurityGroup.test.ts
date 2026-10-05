import * as AWS from "@/AWS";
import { SecurityGroup, SecurityGroupRule, Vpc } from "@/AWS/EC2";
import type {
  SecurityGroupProps,
  SecurityGroupRuleData,
} from "@/AWS/EC2/SecurityGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { MinimumLogLevel } from "effect/References";
import { assertSecurityGroupGone, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const describeRules = (groupId: string) =>
  EC2.describeSecurityGroupRules({
    Filters: [{ Name: "group-id", Values: [groupId] }],
  }).pipe(Effect.map((result) => result.SecurityGroupRules ?? []));

test.provider(
  "list enumerates the deployed Security Group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vpc, sg } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListSgVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const sg = yield* SecurityGroup("ListSg", {
            vpcId: vpc.vpcId,
          });
          return { vpc, sg };
        }),
      );

      const provider = yield* Provider.findProvider(SecurityGroup);
      const all = yield* provider.list();

      expect(all.some((x) => x.groupId === sg.groupId)).toBe(true);

      yield* stack.destroy();

      yield* assertSecurityGroupGone(sg.groupId);
      yield* assertVpcGone(vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"] },
);

test.provider(
  "reconciles inline rules without taking over standalone rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (inlinePort: number, standalone = true) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("MixedRulesVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const sg = yield* SecurityGroup("MixedRulesSg", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "6",
                fromPort: inlinePort,
                toPort: inlinePort,
                cidrIpv4: "10.0.0.7/16",
              },
              {
                ipProtocol: "58",
                fromPort: -1,
                toPort: -1,
                cidrIpv6: "2001:0db8:0:0:0:0:0:5/64",
              },
            ],
            egress: [
              {
                ipProtocol: "6",
                fromPort: inlinePort,
                toPort: inlinePort,
                cidrIpv4: "10.0.0.7/16",
              },
            ],
          });
          const ingressRule = standalone
            ? yield* SecurityGroupRule("StandaloneIngress", {
                groupId: sg.groupId,
                type: "ingress",
                ipProtocol: "tcp",
                fromPort: 5432,
                toPort: 5432,
                cidrIpv4: "10.0.0.0/16",
              })
            : undefined;
          const egressRule = standalone
            ? yield* SecurityGroupRule("StandaloneEgress", {
                groupId: sg.groupId,
                type: "egress",
                ipProtocol: "udp",
                fromPort: 53,
                toPort: 53,
                cidrIpv4: "10.0.0.0/16",
              })
            : undefined;
          return { egressRule, ingressRule, sg, vpc };
        });

      const deployed = yield* stack.deploy(makeStack(443));
      const declared = (yield* describeRules(deployed.sg.groupId)).find(
        (rule) =>
          rule.SecurityGroupRuleId ===
          deployed.ingressRule?.securityGroupRuleId,
      )!;
      // Even copied ownership tags do not delegate an undeclared physical rule.
      const rogue = yield* EC2.authorizeSecurityGroupIngress({
        GroupId: deployed.sg.groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
        ],
        TagSpecifications: [
          { ResourceType: "security-group-rule", Tags: declared.Tags },
        ],
      });
      const rogueId = rogue.SecurityGroupRules![0]!.SecurityGroupRuleId!;
      const stale = yield* EC2.authorizeSecurityGroupEgress({
        GroupId: deployed.sg.groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 25,
            ToPort: 25,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
        ],
        TagSpecifications: [
          {
            ResourceType: "security-group-rule",
            Tags: [{ Key: "alchemy::id", Value: "RemovedRule" }],
          },
        ],
      });
      const staleId = stale.SecurityGroupRules![0]!.SecurityGroupRuleId!;
      expect(
        (yield* describeRules(deployed.sg.groupId).pipe(
          Effect.repeat({
            until: (rules) =>
              rules.some((rule) => rule.SecurityGroupRuleId === rogueId) &&
              rules.some((rule) => rule.SecurityGroupRuleId === staleId),
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        )).some((rule) => rule.SecurityGroupRuleId === rogueId),
      ).toBe(true);
      expect(
        (yield* stack.plan(makeStack(443))).resources.MixedRulesSg?.action,
      ).toBe("update");
      yield* stack.deploy(makeStack(443));
      const repaired = yield* describeRules(deployed.sg.groupId);
      expect(
        repaired.some((rule) =>
          [rogueId, staleId].includes(rule.SecurityGroupRuleId!),
        ),
      ).toBe(false);
      expect(
        repaired.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
            deployed.ingressRule?.securityGroupRuleId,
        ),
      ).toBe(true);
      expect(
        repaired.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
            deployed.egressRule?.securityGroupRuleId,
        ),
      ).toBe(true);
      expect(
        (yield* stack.plan(makeStack(443))).resources.MixedRulesSg?.action,
      ).toBe("noop");
      const updated = yield* stack.deploy(makeStack(8443));

      expect(updated.ingressRule?.securityGroupRuleId).toEqual(
        deployed.ingressRule?.securityGroupRuleId,
      );
      expect(updated.egressRule?.securityGroupRuleId).toEqual(
        deployed.egressRule?.securityGroupRuleId,
      );

      const updatedRules = yield* describeRules(updated.sg.groupId);
      expect(
        updatedRules.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
              updated.ingressRule?.securityGroupRuleId &&
            rule.Tags?.some((tag) => tag.Key === "alchemy::id"),
        ),
      ).toBe(true);
      expect(
        updatedRules.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
              updated.egressRule?.securityGroupRuleId &&
            rule.Tags?.some((tag) => tag.Key === "alchemy::id"),
        ),
      ).toBe(true);
      expect(
        updatedRules.filter(
          (rule) => rule.FromPort === 8443 && rule.ToPort === 8443,
        ),
      ).toHaveLength(2);
      expect(updatedRules.some((rule) => rule.FromPort === 443)).toBe(false);

      yield* stack.deploy(makeStack(8443, false));
      const finalRules = yield* describeRules(updated.sg.groupId);
      expect(
        finalRules.some(
          (rule) =>
            rule.SecurityGroupRuleId ===
              updated.ingressRule?.securityGroupRuleId ||
            rule.SecurityGroupRuleId ===
              updated.egressRule?.securityGroupRuleId,
        ),
      ).toBe(false);
      expect(
        finalRules.filter(
          (rule) => rule.FromPort === 8443 && rule.ToPort === 8443,
        ),
      ).toHaveLength(2);

      yield* stack.destroy();
      yield* assertSecurityGroupGone(updated.sg.groupId);
      yield* assertVpcGone(updated.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

test.provider(
  "creates dual-stack permissions and keeps unchanged rules stable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        const vpc = yield* Vpc("DualStackVpc", { cidrBlock: "10.0.0.0/16" });
        const permission = {
          ipProtocol: "6",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.0.0.7/16",
          cidrIpv6: "2001:0db8:0:0:0:0:0:5/64",
          description: "dual-stack HTTPS",
        };
        const sg = yield* SecurityGroup("DualStackSg", {
          vpcId: vpc.vpcId,
          ingress: [
            permission,
            { ipProtocol: "58", cidrIpv6: "2001:db8::/64" },
          ],
          egress: [permission],
        });
        return { sg, vpc };
      });
      const { sg, vpc } = yield* stack.deploy(program);
      const rules = yield* describeRules(sg.groupId);
      expect(rules).toHaveLength(5);
      for (const isEgress of [false, true]) {
        const https = rules.filter(
          (rule) => rule.IsEgress === isEgress && rule.IpProtocol === "tcp",
        );
        expect(https).toHaveLength(2);
        expect(https.some((rule) => rule.CidrIpv4 === "10.0.0.0/16")).toBe(
          true,
        );
        expect(https.some((rule) => rule.CidrIpv6 === "2001:db8::/64")).toBe(
          true,
        );
      }
      expect((yield* stack.plan(program)).resources.DualStackSg?.action).toBe(
        "noop",
      );
      yield* stack.deploy(program);
      expect(
        (yield* describeRules(sg.groupId))
          .map((rule) => rule.SecurityGroupRuleId)
          .sort(),
      ).toEqual(rules.map((rule) => rule.SecurityGroupRuleId).sort());
      yield* stack.destroy();
      yield* assertSecurityGroupGone(sg.groupId);
      yield* assertVpcGone(vpc.vpcId);
    }),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

const securityGroupStack = (props: { egress?: [] }) =>
  Effect.gen(function* () {
    const vpc = yield* Vpc("EmptyEgressVpc", {
      cidrBlock: "10.0.0.0/16",
    });
    const sg = yield* SecurityGroup("EmptyEgressSg", {
      vpcId: vpc.vpcId,
      ...props,
    });
    return { sg, vpc };
  });

const describeEgress = (groupId: string) =>
  EC2.describeSecurityGroupRules({
    Filters: [{ Name: "group-id", Values: [groupId] }],
  }).pipe(
    Effect.map((result) =>
      (result.SecurityGroupRules ?? []).filter((rule) => rule.IsEgress),
    ),
  );

test.provider(
  "distinguishes explicit empty egress from omitted egress",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Creating with explicitly empty egress removes AWS's default allow-all rule.
      const noOutbound = yield* stack.deploy(
        securityGroupStack({ egress: [] }),
      );
      expect(yield* describeEgress(noOutbound.sg.groupId)).toEqual([]);

      // Redeploying the same configuration must keep outbound access disabled.
      const stillNoOutbound = yield* stack.deploy(
        securityGroupStack({ egress: [] }),
      );
      expect(yield* describeEgress(stillNoOutbound.sg.groupId)).toEqual([]);

      // Omitting the egress property restores default allow-all IPv4 access.
      const defaultOutbound = yield* stack.deploy(securityGroupStack({}));
      const defaultEgress = yield* describeEgress(defaultOutbound.sg.groupId);
      expect(defaultEgress).toHaveLength(1);
      expect(defaultEgress[0]?.IpProtocol).toEqual("-1");
      expect(defaultEgress[0]?.CidrIpv4).toEqual("0.0.0.0/0");

      // Switching back to explicitly empty egress removes allow-all again.
      const outboundDisabledAgain = yield* stack.deploy(
        securityGroupStack({ egress: [] }),
      );
      expect(yield* describeEgress(outboundDisabledAgain.sg.groupId)).toEqual(
        [],
      );

      yield* stack.destroy();
      yield* assertSecurityGroupGone(outboundDisabledAgain.sg.groupId);
      yield* assertVpcGone(outboundDisabledAgain.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

test.provider(
  "creates and updates explicitly empty egress",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (egress: SecurityGroupRuleData[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("EmptyEgressVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const sg = yield* SecurityGroup("EmptyEgressSg", {
              vpcId: vpc.vpcId,
              egress,
            });
            return { vpc, sg };
          }),
        );
      const created = yield* deploy([]);
      const initial = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(initial.SecurityGroupRules).toEqual([]);
      const configured = yield* deploy([
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "0.0.0.0/0",
        },
      ]);
      expect(configured.sg.groupId).toBe(created.sg.groupId);
      const configuredRules = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(configuredRules.SecurityGroupRules).toEqual([
        expect.objectContaining({
          IsEgress: true,
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          CidrIpv4: "0.0.0.0/0",
        }),
      ]);
      const updated = yield* deploy([]);
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const final = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(final.SecurityGroupRules).toEqual([]);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120000 },
);

test.provider(
  "repairs inline drift without replacing unchanged rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("InlineDriftVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const sg = yield* SecurityGroup("InlineDriftSg", {
              vpcId: vpc.vpcId,
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 443,
                  toPort: 443,
                  cidrIpv4: "10.0.0.0/16",
                },
              ],
              egress: [],
            });
            return { vpc, sg };
          }),
        );
      const created = yield* deploy();
      const originalRuleId = created.sg.ingressRules?.[0]?.securityGroupRuleId;
      yield* EC2.authorizeSecurityGroupIngress({
        GroupId: created.sg.groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "10.0.0.0/16" }],
          },
        ],
      });
      const updated = yield* deploy();
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const rules = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
      });
      expect(rules.SecurityGroupRules).toEqual([
        expect.objectContaining({
          SecurityGroupRuleId: originalRuleId,
          FromPort: 443,
        }),
      ]);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120000 },
);

test.provider(
  "omitted directions restore defaults while empty directions disable traffic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const makeStack = (
        directions: Pick<SecurityGroupProps, "ingress" | "egress">,
        label: string,
      ) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("DirectionsVpc", { cidrBlock: "10.0.0.0/16" });
          const sg = yield* SecurityGroup("DirectionsSg", {
            vpcId: vpc.vpcId,
            ...directions,
            tags: { Label: label },
          });
          return { vpc, sg };
        });
      const rule: SecurityGroupRuleData = {
        ipProtocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrIpv4: "10.0.0.0/16",
      };
      const created = yield* stack.deploy(
        makeStack({ ingress: [rule], egress: [rule] }, "managed"),
      );
      const readRules = () =>
        EC2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
        });
      const initial = yield* readRules();
      expect(initial.SecurityGroupRules).toHaveLength(2);
      const defaults = yield* stack.deploy(makeStack({}, "defaults"));
      expect(defaults.sg.groupId).toBe(created.sg.groupId);
      const defaultRules = yield* readRules();
      expect(defaultRules.SecurityGroupRules).toEqual([
        expect.objectContaining({
          IsEgress: true,
          IpProtocol: "-1",
          CidrIpv4: "0.0.0.0/0",
        }),
      ]);

      const ingressEmpty = yield* stack.deploy(
        makeStack({ ingress: [] }, "ingress-empty"),
      );
      expect(ingressEmpty.sg.groupId).toBe(created.sg.groupId);
      const egressOnly = yield* readRules();
      expect(egressOnly.SecurityGroupRules).toEqual(
        defaultRules.SecurityGroupRules,
      );

      const emptyStack = makeStack({ egress: [] }, "egress-empty");
      const empty = yield* stack.deploy(emptyStack);
      expect(empty.sg.groupId).toBe(created.sg.groupId);
      expect((yield* readRules()).SecurityGroupRules).toEqual([]);
      const plan = yield* stack.plan(emptyStack);
      expect(plan.resources.DirectionsSg).toMatchObject({ action: "noop" });
      yield* stack.deploy(emptyStack);
      expect((yield* readRules()).SecurityGroupRules).toEqual([]);
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120000 },
);

test.provider(
  "updates and clears inline descriptions without replacing ingress or egress rule IDs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const makeStack = (description: string | undefined) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("DescriptionsVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const rule: SecurityGroupRuleData = {
            ipProtocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrIpv4: "10.0.0.0/16",
            description,
          };
          const sg = yield* SecurityGroup("DescriptionsSg", {
            vpcId: vpc.vpcId,
            ingress: [rule],
            egress: [rule],
          });
          return { vpc, sg };
        });
      const created = yield* stack.deploy(makeStack("before"));
      const readRules = () =>
        EC2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
        });
      const initial = yield* readRules();
      expect(initial.SecurityGroupRules).toHaveLength(2);
      for (const rule of initial.SecurityGroupRules ?? []) {
        expect(rule.SecurityGroupRuleId).toMatch(/^sgr-/);
        expect(rule.Description).toBe("before");
      }
      for (const description of ["after", "", undefined]) {
        const updated = yield* stack.deploy(makeStack(description));
        expect(updated.sg.groupId).toBe(created.sg.groupId);
        expect(updated.sg.groupArn).toBe(created.sg.groupArn);
        expect(updated.sg.ownerId).toBe(created.sg.ownerId);
        const observed = yield* readRules();
        expect(observed.SecurityGroupRules).toHaveLength(2);
        for (const original of initial.SecurityGroupRules ?? []) {
          const rule = observed.SecurityGroupRules?.find(
            (rule) => rule.SecurityGroupRuleId === original.SecurityGroupRuleId,
          );
          expect(rule).toBeDefined();
          expect(rule?.IsEgress).toBe(original.IsEgress);
          expect(rule?.Description ?? "").toBe(description ?? "");
        }
      }
      const plan = yield* stack.plan(makeStack(undefined));
      expect(plan.resources.DescriptionsSg).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120000 },
);

test.provider(
  "updates only changed inline rules and repairs a missing rule before a noop deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const retained: SecurityGroupRuleData = {
        ipProtocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrIpv4: "10.0.0.0/16",
      };
      const before: SecurityGroupRuleData = {
        ipProtocol: "tcp",
        fromPort: 22,
        toPort: 22,
        cidrIpv4: "10.0.0.0/16",
      };
      const after: SecurityGroupRuleData = {
        ipProtocol: "udp",
        fromPort: 53,
        toPort: 53,
        cidrIpv4: "10.1.0.0/16",
      };
      const makeStack = (rule: SecurityGroupRuleData) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("RuleDeltaVpc", { cidrBlock: "10.0.0.0/16" });
          const sg = yield* SecurityGroup("RuleDeltaSg", {
            vpcId: vpc.vpcId,
            ingress: [retained, rule],
            egress: [],
          });
          return { vpc, sg };
        });
      const created = yield* stack.deploy(makeStack(before));
      const readRules = () =>
        EC2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
        });
      const initial = yield* readRules();
      expect(initial.SecurityGroupRules).toHaveLength(2);
      const retainedRule = initial.SecurityGroupRules?.find(
        (rule) => rule.FromPort === 443,
      );
      const removedRule = initial.SecurityGroupRules?.find(
        (rule) => rule.FromPort === 22,
      );
      expect(retainedRule?.SecurityGroupRuleId).toMatch(/^sgr-/);
      expect(removedRule?.SecurityGroupRuleId).toMatch(/^sgr-/);
      const desiredStack = makeStack(after);
      const updatePlan = yield* stack.plan(desiredStack);
      expect(updatePlan.resources.RuleDeltaSg).toMatchObject({
        action: "update",
      });
      const updated = yield* stack.deploy(desiredStack);
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      expect(updated.sg.groupArn).toBe(created.sg.groupArn);
      expect(updated.sg.ownerId).toBe(created.sg.ownerId);
      const changed = yield* readRules();
      expect(changed.SecurityGroupRules).toHaveLength(2);
      expect(changed.SecurityGroupRules).toEqual(
        expect.arrayContaining([
          retainedRule,
          expect.objectContaining({
            IsEgress: false,
            IpProtocol: "udp",
            FromPort: 53,
            ToPort: 53,
            CidrIpv4: "10.1.0.0/16",
          }),
        ]),
      );
      expect(
        changed.SecurityGroupRules?.some(
          (rule) =>
            rule.SecurityGroupRuleId === removedRule?.SecurityGroupRuleId,
        ),
      ).toBe(false);
      const addedRule = changed.SecurityGroupRules?.find(
        (rule) => rule.FromPort === 53,
      );
      expect(addedRule?.SecurityGroupRuleId).toMatch(/^sgr-/);
      yield* EC2.revokeSecurityGroupIngress({
        GroupId: created.sg.groupId,
        SecurityGroupRuleIds: [addedRule!.SecurityGroupRuleId!],
      });
      const drifted = yield* readRules().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
          until: (response) =>
            response.SecurityGroupRules?.length === 1 &&
            response.SecurityGroupRules[0]?.SecurityGroupRuleId ===
              retainedRule?.SecurityGroupRuleId,
        }),
      );
      expect(drifted.SecurityGroupRules).toEqual([retainedRule]);
      const repairPlan = yield* stack.plan(desiredStack);
      expect(repairPlan.resources.RuleDeltaSg).toMatchObject({
        action: "update",
      });
      const repaired = yield* stack.deploy(desiredStack);
      expect(repaired.sg.groupId).toBe(created.sg.groupId);
      const restored = yield* readRules();
      expect(restored.SecurityGroupRules).toHaveLength(2);
      expect(restored.SecurityGroupRules).toEqual(
        expect.arrayContaining([
          retainedRule,
          expect.objectContaining({
            IsEgress: false,
            IpProtocol: "udp",
            FromPort: 53,
            ToPort: 53,
            CidrIpv4: "10.1.0.0/16",
          }),
        ]),
      );
      expect(
        restored.SecurityGroupRules?.some(
          (rule) => rule.SecurityGroupRuleId === addedRule?.SecurityGroupRuleId,
        ),
      ).toBe(false);
      const noopPlan = yield* stack.plan(desiredStack);
      expect(noopPlan.resources.RuleDeltaSg).toMatchObject({ action: "noop" });
      yield* stack.deploy(desiredStack);
      const unchanged = yield* readRules();
      expect(unchanged.SecurityGroupRules).toHaveLength(2);
      expect(unchanged.SecurityGroupRules).toEqual(
        expect.arrayContaining(restored.SecurityGroupRules ?? []),
      );
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120000 },
);

test.provider(
  "recreates a deleted group and updates its standalone rule dependency",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const resources = Effect.gen(function* () {
        const vpc = yield* Vpc("MissingGroupVpc", { cidrBlock: "10.0.0.0/16" });
        const sg = yield* SecurityGroup("MissingGroupSg", {
          vpcId: vpc.vpcId,
          egress: [],
        });
        const rule = yield* SecurityGroupRule("MissingGroupRule", {
          groupId: sg.groupId,
          type: "ingress",
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.0.0.0/16",
        });
        return { vpc, sg, rule };
      });
      const created = yield* stack.deploy(resources);
      yield* EC2.deleteSecurityGroup({ GroupId: created.sg.groupId });
      yield* assertSecurityGroupGone(created.sg.groupId);
      const repaired = yield* stack.deploy(resources);
      expect(repaired.sg.groupId).not.toBe(created.sg.groupId);
      expect(repaired.rule.groupId).toBe(repaired.sg.groupId);
      expect(repaired.rule.securityGroupRuleId).not.toBe(
        created.rule.securityGroupRuleId,
      );
      const observed = yield* EC2.describeSecurityGroupRules({
        Filters: [{ Name: "group-id", Values: [repaired.sg.groupId] }],
      });
      expect(observed.SecurityGroupRules).toEqual([
        expect.objectContaining({
          SecurityGroupRuleId: repaired.rule.securityGroupRuleId,
          IsEgress: false,
          FromPort: 443,
        }),
      ]);
      const plan = yield* stack.plan(resources);
      expect(plan.resources.MissingGroupSg).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertSecurityGroupGone(repaired.sg.groupId);
      yield* assertVpcGone(repaired.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120000 },
);

test.provider(
  "canonical inline rules retain IDs across equivalent updates and noop deploys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const supplied: SecurityGroupRuleData[] = [
        {
          ipProtocol: "6",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "100.68.0.18/18",
          cidrIpv6: "2001:DB8:0:0:ABCD:0123:4567:89ab/64",
          description: "",
        },
        {
          ipProtocol: "17",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.0.0.1/16",
        },
        {
          ipProtocol: "1",
          fromPort: 8,
          toPort: -1,
          cidrIpv4: "10.0.0.1/16",
        },
        {
          ipProtocol: "-1",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.1.0.1/16",
        },
        {
          ipProtocol: "50",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.2.0.1/16",
        },
        { ipProtocol: "icmpv6", cidrIpv6: "::/0" },
      ];
      const canonical: SecurityGroupRuleData[] = [
        {
          ipProtocol: "58",
          fromPort: -1,
          toPort: -1,
          cidrIpv6: "::/0",
        },
        { ipProtocol: "50", cidrIpv4: "10.2.0.0/16" },
        { ipProtocol: "-1", cidrIpv4: "10.1.0.0/16" },
        {
          ipProtocol: "icmp",
          fromPort: 8,
          toPort: -1,
          cidrIpv4: "10.0.0.0/16",
        },
        {
          ipProtocol: "udp",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.0.0.0/16",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv6: "2001:db8::/64",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "100.68.0.0/18",
        },
      ];
      const makeStack = (ingress: SecurityGroupRuleData[], label: string) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("CanonicalVpc", { cidrBlock: "10.0.0.0/16" });
          const sg = yield* SecurityGroup("CanonicalSg", {
            vpcId: vpc.vpcId,
            ingress,
            egress: [],
            tags: { Label: label },
          });
          return { vpc, sg };
        });
      const created = yield* stack.deploy(makeStack(supplied, "before"));
      const readRules = () =>
        EC2.describeSecurityGroupRules({
          Filters: [{ Name: "group-id", Values: [created.sg.groupId] }],
        });
      const initial = yield* readRules();
      expect(initial.SecurityGroupRules).toHaveLength(7);
      for (const rule of canonical) {
        expect(initial.SecurityGroupRules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              IsEgress: false,
              IpProtocol:
                rule.ipProtocol === "58"
                  ? expect.stringMatching(/^(58|icmpv6)$/)
                  : rule.ipProtocol,
              ...(rule.fromPort === undefined
                ? {}
                : { FromPort: rule.fromPort }),
              ...(rule.toPort === undefined ? {} : { ToPort: rule.toPort }),
              ...(rule.cidrIpv4 === undefined
                ? {}
                : { CidrIpv4: rule.cidrIpv4 }),
              ...(rule.cidrIpv6 === undefined
                ? {}
                : { CidrIpv6: rule.cidrIpv6 }),
            }),
          ]),
        );
      }
      const originalPlan = yield* stack.plan(makeStack(supplied, "before"));
      expect(originalPlan.resources.CanonicalSg).toMatchObject({
        action: "noop",
      });

      const equivalentStack = makeStack(canonical, "after");
      const updated = yield* stack.deploy(equivalentStack);
      expect(updated.sg.groupId).toBe(created.sg.groupId);
      const equivalent = yield* readRules();
      expect(equivalent.SecurityGroupRules).toHaveLength(7);
      expect(equivalent.SecurityGroupRules).toEqual(
        expect.arrayContaining(initial.SecurityGroupRules ?? []),
      );
      const plan = yield* stack.plan(equivalentStack);
      expect(plan.resources.CanonicalSg).toMatchObject({ action: "noop" });
      yield* stack.deploy(equivalentStack);
      const unchanged = yield* readRules();
      expect(unchanged.SecurityGroupRules).toHaveLength(7);
      expect(unchanged.SecurityGroupRules).toEqual(
        expect.arrayContaining(initial.SecurityGroupRules ?? []),
      );
      yield* stack.destroy();
      yield* assertSecurityGroupGone(created.sg.groupId);
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120000 },
);
