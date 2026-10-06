import * as AWS from "@/AWS";
import {
  DefaultSecurityGroup,
  NetworkInterface,
  PrefixList,
  SecurityGroup,
  SecurityGroupRule,
  Subnet,
  Vpc,
} from "@/AWS/EC2";
import type {
  DefaultSecurityGroupProps,
  SecurityGroupRuleData,
  VpcId,
} from "@/AWS/EC2";
import * as Drift from "@/Drift";
import * as Output from "@/Output";
import { isActionState, State } from "@/State/State";
import * as Core from "@/Test/Core";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as Test from "./VpcTest.ts";
import { assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() }, 2);
const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "AWS creates the default group with its initial rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const vpc = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DefaultSecurityGroupInitialVpc", {
            cidrBlock: "10.43.0.0/16",
          });
        }),
      );

      const group = yield* findDefaultGroup(vpc.vpcId);
      yield* expectRules(
        group.GroupId!,
        [
          {
            IpProtocol: "-1",
            ReferencedGroupInfo: { GroupId: group.GroupId! },
          },
        ],
        [{ IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" }],
      );

      yield* stack.destroy();
      yield* assertVpcGone(vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"] },
);

// This changes the AWS-created default security group only inside the VPC this
// test creates and destroys.
test.provider(
  "manages a temporary VPC's default security group without deleting it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The VPC output is consumed in this same first deployment. This proves
      // that the default group can be found and closed without a second deploy.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          const defaultSecurityGroup = yield* DefaultSecurityGroup(
            "DefaultSecurityGroup",
            {
              vpcId: vpc.vpcId,
              ingress: [],
              egress: [],
            },
          );
          return { vpc, defaultSecurityGroup };
        }),
      );

      const defaultGroup = yield* findDefaultGroup(initial.vpc.vpcId);
      expect(initial.defaultSecurityGroup.groupId).toEqual(
        defaultGroup.GroupId,
      );
      yield* expectRules(initial.defaultSecurityGroup.groupId, [], []);

      // A second identical deployment verifies idempotence against AWS readback.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          return yield* DefaultSecurityGroup("DefaultSecurityGroup", {
            vpcId: vpc.vpcId,
            ingress: [],
            egress: [],
          });
        }),
      );
      yield* expectRules(initial.defaultSecurityGroup.groupId, [], []);

      // A changed inline declaration replaces the inline rule set.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
          return yield* DefaultSecurityGroup("DefaultSecurityGroup", {
            vpcId: vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.42.0.0/16",
              },
            ],
            egress: [],
          });
        }),
      );
      yield* expectRules(
        initial.defaultSecurityGroup.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.42.0.0/16",
          },
        ],
        [],
      );

      // Removing the Alchemy resource must not delete the AWS-owned group or
      // restore its initial AWS rules.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vpc("DefaultSecurityGroupVpc", {
            cidrBlock: "10.42.0.0/16",
          });
        }),
      );
      const preserved = yield* findDefaultGroup(initial.vpc.vpcId);
      expect(preserved.GroupId).toEqual(initial.defaultSecurityGroup.groupId);
      yield* expectRules(
        initial.defaultSecurityGroup.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.42.0.0/16",
          },
        ],
        [],
      );

      yield* stack.destroy();
      yield* assertVpcGone(initial.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"] },
);

for (const direction of ["ingress", "egress"] as const) {
  test.provider(
    `repairs ${direction} drift and applies only changed rules`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const retained: SecurityGroupRuleData = {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.44.0.0/16",
          description: "retained",
        };
        const changed: SecurityGroupRuleData = {
          ipProtocol: "udp",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.44.0.0/16",
          description: "DNS",
        };
        const program = (rules = [retained, changed]) =>
          Effect.gen(function* () {
            const vpc = yield* Vpc("DriftVpc", { cidrBlock: "10.44.0.0/16" });
            const group = yield* DefaultSecurityGroup("DriftGroup", {
              vpcId: vpc.vpcId,
              ingress: direction === "ingress" ? rules : [retained],
              egress: direction === "egress" ? rules : [retained],
            });
            return { vpc, group };
          });
        const created = yield* stack.deploy(program());
        const groupId = created.group.groupId;
        const initial = yield* readRules(groupId);
        const stable = initial.filter((rule) => rule.FromPort === 443);
        expect(stable).toHaveLength(2);
        const missing = initial.find((rule) => rule.FromPort === 53)!;
        const revoke =
          direction === "ingress"
            ? EC2.revokeSecurityGroupIngress
            : EC2.revokeSecurityGroupEgress;
        const authorize =
          direction === "ingress"
            ? EC2.authorizeSecurityGroupIngress
            : EC2.authorizeSecurityGroupEgress;
        yield* revoke({
          GroupId: groupId,
          SecurityGroupRuleIds: [missing.SecurityGroupRuleId!],
        });
        const rogue = yield* authorize({
          GroupId: groupId,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: 22,
              ToPort: 22,
              IpRanges: [{ CidrIp: "0.0.0.0/0" }],
            },
          ],
          TagSpecifications: [
            {
              ResourceType: "security-group-rule",
              Tags: [{ Key: "alchemy::id", Value: "DriftGroup" }],
            },
          ],
        });
        const rogueId = rogue.SecurityGroupRules![0]!.SecurityGroupRuleId!;
        yield* waitForRules(
          groupId,
          (rules) =>
            !rules.some(
              (rule) =>
                rule.SecurityGroupRuleId === missing.SecurityGroupRuleId,
            ) && rules.some((rule) => rule.SecurityGroupRuleId === rogueId),
        );
        const missingRuleError = yield* EC2.modifySecurityGroupRules({
          GroupId: groupId,
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: missing.SecurityGroupRuleId!,
              SecurityGroupRule: {
                IpProtocol: "udp",
                FromPort: 53,
                ToPort: 53,
                CidrIpv4: "10.44.0.0/16",
                Description: "missing rule probe",
              },
            },
          ],
        }).pipe(Effect.flip);
        expect(missingRuleError).toMatchObject({
          _tag: "InvalidSecurityGroupRuleId.NotFound",
        });
        expect(
          (yield* stack.plan(program())).resources.DriftGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program());
        const repaired = yield* readRules(groupId);
        expect(repaired).toHaveLength(3);
        expect(repaired).toEqual(expect.arrayContaining(stable));
        const restored = repaired.find((rule) => rule.FromPort === 53)!;
        expect(restored.SecurityGroupRuleId).not.toBe(
          missing.SecurityGroupRuleId,
        );
        expect(restored.IsEgress).toBe(direction === "egress");
        expect(restored.Description).toBe("DNS");
        expect(
          repaired.some((rule) => rule.SecurityGroupRuleId === rogueId),
        ).toBe(false);

        yield* EC2.modifySecurityGroupRules({
          GroupId: groupId,
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: restored.SecurityGroupRuleId!,
              SecurityGroupRule: {
                IpProtocol: "udp",
                FromPort: 53,
                ToPort: 53,
                CidrIpv4: "10.44.0.0/16",
                Description: "external description",
              },
            },
          ],
        });
        yield* waitForRules(groupId, (rules) =>
          rules.some(
            (rule) =>
              rule.SecurityGroupRuleId === restored.SecurityGroupRuleId &&
              rule.Description === "external description",
          ),
        );
        expect(
          (yield* stack.plan(program())).resources.DriftGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program());
        const descriptions = yield* readRules(groupId);
        expect(descriptions).toEqual(
          expect.arrayContaining([...stable, restored]),
        );

        // External identity edits are removed, not preserved as extra access.
        yield* EC2.modifySecurityGroupRules({
          GroupId: groupId,
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: restored.SecurityGroupRuleId!,
              SecurityGroupRule: {
                IpProtocol: "tcp",
                FromPort: 25,
                ToPort: 25,
                CidrIpv4: "0.0.0.0/0",
                Description: "external access",
              },
            },
          ],
        });
        yield* waitForRules(groupId, (rules) =>
          rules.some(
            (rule) =>
              rule.SecurityGroupRuleId === restored.SecurityGroupRuleId &&
              rule.FromPort === 25,
          ),
        );
        expect(
          (yield* stack.plan(program())).resources.DriftGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program());
        const repairedIdentity = yield* readRules(groupId);
        expect(repairedIdentity).toHaveLength(3);
        expect(repairedIdentity).toEqual(expect.arrayContaining(stable));
        expect(repairedIdentity.some((rule) => rule.FromPort === 25)).toBe(
          false,
        );
        expect(
          repairedIdentity.find((rule) => rule.FromPort === 53)?.Description,
        ).toBe("DNS");

        const replacement = {
          ...changed,
          fromPort: 123,
          toPort: 123,
          description: "NTP",
        };
        yield* stack.deploy(program([retained, replacement]));
        const edited = yield* readRules(groupId);
        expect(edited).toHaveLength(3);
        expect(edited).toEqual(expect.arrayContaining(stable));
        expect(edited.some((rule) => rule.FromPort === 53)).toBe(false);
        expect(edited.find((rule) => rule.FromPort === 123)?.Description).toBe(
          "NTP",
        );

        yield* stack.deploy(program([]));
        const opposite = stable.filter(
          (rule) => rule.IsEgress !== (direction === "egress"),
        );
        expect(yield* readRules(groupId)).toEqual(opposite);
        const external = yield* authorize({
          GroupId: groupId,
          IpPermissions: [
            { IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
          ],
        });
        yield* waitForRules(groupId, (rules) =>
          rules.some(
            (rule) =>
              rule.SecurityGroupRuleId ===
              external.SecurityGroupRules![0]!.SecurityGroupRuleId,
          ),
        );
        expect(
          (yield* stack.plan(program([]))).resources.DriftGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program([]));
        expect(yield* readRules(groupId)).toEqual(opposite);

        const observer = yield* observeRuleRequests;
        yield* Effect.gen(function* () {
          expect(
            (yield* stack.plan(program([]))).resources.DriftGroup?.action,
          ).toBe("noop");
          yield* stack.deploy(program([]));
        }).pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
        expect(observer.requests.length).toBeGreaterThan(0);
        expect(observer.requests.filter((request) => request.write)).toEqual(
          [],
        );
        expect(yield* readRules(groupId)).toEqual(opposite);
        yield* stack.destroy();
        yield* assertVpcGone(created.vpc.vpcId);
      }).pipe(logLevel),
    { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
  );
}

test.provider(
  "canonicalizes and deduplicates rules while preserving IDs and updating descriptions in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const dual: SecurityGroupRuleData = {
        ipProtocol: "6",
        fromPort: 443,
        toPort: 443,
        cidrIpv4: "10.45.0.7/16",
        cidrIpv6: "2001:0DB8:0:0:0:0:0:5/64",
        description: "HTTPS",
      };
      const supplied: SecurityGroupRuleData[] = [
        dual,
        { ...dual, cidrIpv4: "10.45.0.0/16" },
        { ipProtocol: "58", cidrIpv6: "2001:db8::1/64" },
        {
          ipProtocol: "-1",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.46.0.1/16",
        },
        {
          ipProtocol: "50",
          fromPort: 0,
          toPort: 65535,
          cidrIpv4: "10.47.0.1/16",
        },
        {
          ipProtocol: "17",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.45.0.7/16",
        },
        { ipProtocol: "1", fromPort: 8, toPort: -1, cidrIpv4: "10.45.0.7/16" },
      ];
      const canonical: SecurityGroupRuleData[] = [
        {
          ipProtocol: "icmp",
          fromPort: 8,
          toPort: -1,
          cidrIpv4: "10.45.0.0/16",
        },
        {
          ipProtocol: "udp",
          fromPort: 53,
          toPort: 53,
          cidrIpv4: "10.45.0.0/16",
        },
        { ipProtocol: "50", cidrIpv4: "10.47.0.0/16" },
        { ipProtocol: "-1", cidrIpv4: "10.46.0.0/16" },
        {
          ipProtocol: "icmpv6",
          fromPort: -1,
          toPort: -1,
          cidrIpv6: "2001:db8::/64",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv6: "2001:db8::/64",
          description: "HTTPS",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.45.0.0/16",
          description: "HTTPS",
        },
      ];
      const program = (rules: SecurityGroupRuleData[]) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("CanonicalVpc", { cidrBlock: "10.45.0.0/16" });
          const group = yield* DefaultSecurityGroup("CanonicalGroup", {
            vpcId: vpc.vpcId,
            ingress: rules,
            egress: rules,
          });
          return { vpc, group };
        });
      const created = yield* stack.deploy(program(supplied));
      const groupId = created.group.groupId;
      const initial = yield* readRules(groupId);
      expect(initial).toHaveLength(14);
      for (const isEgress of [false, true]) {
        const rules = initial.filter((rule) => rule.IsEgress === isEgress);
        expect(rules).toHaveLength(7);
        expect(rules.filter((rule) => rule.IpProtocol === "tcp")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              CidrIpv4: "10.45.0.0/16",
              Description: "HTTPS",
            }),
            expect.objectContaining({
              CidrIpv6: "2001:db8::/64",
              Description: "HTTPS",
            }),
          ]),
        );
        expect(
          rules.some(
            (rule) =>
              ["58", "icmpv6"].includes(rule.IpProtocol!) &&
              rule.FromPort === -1 &&
              rule.ToPort === -1,
          ),
        ).toBe(true);
      }
      expect(
        (yield* stack.plan(program(supplied))).resources.CanonicalGroup?.action,
      ).toBe("noop");
      const observer = yield* observeRuleRequests;
      yield* stack
        .deploy(program(canonical))
        .pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
      expect(observer.requests.length).toBeGreaterThan(0);
      expect(observer.requests.filter((request) => request.write)).toEqual([]);
      expect(yield* readRules(groupId)).toEqual(
        expect.arrayContaining(initial),
      );
      expect(yield* readRules(groupId)).toHaveLength(initial.length);

      for (const description of ["Updated HTTPS", undefined]) {
        const desired = canonical.map((rule) =>
          rule.ipProtocol === "tcp" ? { ...rule, description } : rule,
        );
        const writes = yield* observeRuleRequests;
        yield* stack
          .deploy(program(desired))
          .pipe(Effect.provideService(HttpClient.HttpClient, writes.client));
        const mutations = writes.requests.filter((request) => request.write);
        expect(mutations.length).toBeGreaterThan(0);
        expect(
          mutations.every(
            (request) => request.action === "ModifySecurityGroupRules",
          ),
        ).toBe(true);
        expect(
          [...new Set(mutations.flatMap((request) => request.ruleIds))].sort(),
        ).toEqual(
          initial
            .filter((rule) => rule.IpProtocol === "tcp")
            .map((rule) => rule.SecurityGroupRuleId)
            .sort(),
        );
        const observed = yield* readRules(groupId);
        expect(observed.map((rule) => rule.SecurityGroupRuleId).sort()).toEqual(
          initial.map((rule) => rule.SecurityGroupRuleId).sort(),
        );
        for (const rule of observed) {
          if (rule.IpProtocol === "tcp")
            expect(rule.Description ?? "").toBe(description ?? "");
        }
        expect(
          (yield* stack.plan(program(desired))).resources.CanonicalGroup
            ?.action,
        ).toBe("noop");
        const noop = yield* observeRuleRequests;
        yield* stack
          .deploy(program(desired))
          .pipe(Effect.provideService(HttpClient.HttpClient, noop.client));
        expect(noop.requests.length).toBeGreaterThan(0);
        expect(noop.requests.filter((request) => request.write)).toEqual([]);
      }
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

test.provider(
  "recovers cold state and adopts existing default-group rules authoritatively",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (port: number, vpcId?: VpcId) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("RecoveryVpc", { cidrBlock: "10.48.0.0/16" });
          const group = yield* DefaultSecurityGroup("RecoveryGroup", {
            vpcId: vpcId ?? vpc.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: port,
                toPort: port,
                cidrIpv4: "10.48.0.0/16",
              },
            ],
            egress: [],
          });
          return { vpc, group };
        });
      const created = yield* stack.deploy(program(443));
      const key = {
        stack: stack.name,
        stage: stack.stage,
        fqn: "RecoveryGroup",
      };
      const state = yield* Effect.gen(function* () {
        return yield* yield* State;
      }).pipe(Effect.provide(stack.state));
      const row = yield* state.get(key);
      if (
        !row ||
        isActionState(row) ||
        (row.status !== "created" && row.status !== "updated")
      ) {
        return yield* Effect.fail(
          new Error("Expected a persisted default security group"),
        );
      }
      const rules = yield* readRules(created.group.groupId);
      yield* state.set({
        ...key,
        value: { ...row, status: "creating", attr: undefined },
      });
      const recoveryPlan = yield* stack.plan(program(443, created.vpc.vpcId));
      expect(recoveryPlan.resources.RecoveryGroup?.state?.attr?.groupId).toBe(
        created.group.groupId,
      );
      const observer = yield* observeRuleRequests;
      const recovered = yield* stack
        .deploy(program(443, created.vpc.vpcId))
        .pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
      expect(recovered.group.groupId).toBe(created.group.groupId);
      expect(observer.requests.length).toBeGreaterThan(0);
      expect(observer.requests.filter((request) => request.write)).toEqual([]);
      expect(yield* readRules(created.group.groupId)).toEqual(rules);

      // Lose only the managed-group row; the VPC remains tracked for cleanup.
      yield* state.delete(key);
      const adoptedPlan = yield* stack.plan(program(8443, created.vpc.vpcId));
      expect(adoptedPlan.resources.RecoveryGroup?.state?.attr?.groupId).toBe(
        created.group.groupId,
      );
      const adopted = yield* stack.deploy(program(8443, created.vpc.vpcId));
      expect(adopted.group.groupId).toBe(created.group.groupId);
      yield* expectRules(
        created.group.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 8443,
            ToPort: 8443,
            CidrIpv4: "10.48.0.0/16",
          },
        ],
        [],
      );
      expect(
        (yield* stack.plan(program(8443, created.vpc.vpcId))).resources
          .RecoveryGroup?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

test.provider(
  "reads a missing VPC as absent and destroys stale state idempotently",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("MissingVpc", { cidrBlock: "10.49.0.0/16" });
          const group = yield* DefaultSecurityGroup("MissingGroup", {
            vpcId: vpc.vpcId,
            ingress: [],
            egress: [],
          });
          return { vpc, group };
        }),
      );
      yield* EC2.deleteVpc({ VpcId: created.vpc.vpcId });
      yield* assertVpcGone(created.vpc.vpcId);
      const drift = yield* Drift.detect(stack).pipe(
        Effect.provide(stack.state),
      );
      expect(drift.resources.MissingGroup?.action).toBe("missing");
      expect(drift.resources.MissingGroup?.attr).toBeUndefined();
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "MissingGroup",
        });
      }).pipe(Effect.provide(stack.state));
      const cold = yield* stack.plan(
        Effect.gen(function* () {
          yield* Vpc("MissingVpc", { cidrBlock: "10.49.0.0/16" });
          return yield* DefaultSecurityGroup("MissingGroup", {
            vpcId: created.vpc.vpcId,
            ingress: [],
            egress: [],
          });
        }),
      );
      expect(cold.resources.MissingGroup?.action).toBe("create");
      expect(cold.resources.MissingGroup?.state).toBeUndefined();
      yield* stack.destroy();
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

test.provider(
  "replaces VPC identity while retaining the old group's last-applied rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (useSecond: boolean, keepFirst = true) =>
        Effect.gen(function* () {
          const first = keepFirst
            ? yield* Vpc("FirstVpc", { cidrBlock: "10.50.0.0/16" })
            : undefined;
          const second = yield* Vpc("SecondVpc", { cidrBlock: "10.51.0.0/16" });
          const group = yield* DefaultSecurityGroup("MovingGroup", {
            vpcId: useSecond ? second.vpcId : first!.vpcId,
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.50.0.0/16",
              },
            ],
            egress: [],
          });
          return { first, second, group };
        });
      const created = yield* stack.deploy(program(false));
      const oldVpcId = created.first!.vpcId;
      const oldRules = yield* readRules(created.group.groupId);
      expect(oldRules).toHaveLength(1);
      expect(
        (yield* stack.plan(program(true))).resources.MovingGroup?.action,
      ).toBe("replace");
      const moved = yield* stack.deploy(program(true));
      expect(moved.group.groupId).not.toBe(created.group.groupId);
      expect(moved.group.vpcId).toBe(created.second.vpcId);
      expect((yield* findDefaultGroup(oldVpcId)).GroupId).toBe(
        created.group.groupId,
      );
      expect(yield* readRules(created.group.groupId)).toEqual(oldRules);
      yield* expectRules(
        moved.group.groupId,
        [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: "10.50.0.0/16",
          },
        ],
        [],
      );
      const newRules = yield* readRules(moved.group.groupId);
      // Remove the old dependency only after its resource replacement is complete.
      yield* stack.deploy(program(true, false));
      yield* assertVpcGone(oldVpcId);
      expect(yield* readRules(moved.group.groupId)).toEqual(newRules);
      expect(
        (yield* stack.plan(program(true, false))).resources.MovingGroup?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertVpcGone(created.second.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

for (const scenario of [
  "new destination VPC",
  "upstream VPC replacement",
] as const) {
  test.provider(
    `propagates unresolved group identity to a real ENI during ${scenario}`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (switchVpc: boolean) =>
          Effect.gen(function* () {
            const original = yield* Vpc("IdentityVpc", {
              cidrBlock:
                switchVpc && scenario === "upstream VPC replacement"
                  ? "10.53.0.0/16"
                  : "10.52.0.0/16",
            });
            // Keep the original VPC declared while introducing its destination.
            const destination =
              switchVpc && scenario === "new destination VPC"
                ? yield* Vpc("DestinationVpc", { cidrBlock: "10.53.0.0/16" })
                : original;
            const group = yield* DefaultSecurityGroup("IdentityGroup", {
              vpcId: destination.vpcId,
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 443,
                  toPort: 443,
                  cidrIpv4: "10.52.0.0/16",
                },
              ],
              egress: [],
            });
            const subnet = switchVpc
              ? yield* Subnet("ConsumerSubnet", {
                  vpcId: destination.vpcId,
                  cidrBlock: "10.53.1.0/24",
                })
              : undefined;
            const eni = subnet
              ? yield* NetworkInterface("ConsumerInterface", {
                  subnetId: subnet.subnetId,
                  securityGroupIds: [group.groupId],
                })
              : undefined;
            return { original, destination, group, subnet, eni };
          });
        const created = yield* stack.deploy(program(false));
        const oldRules = yield* readRules(created.group.groupId);
        const plan = yield* stack.plan(program(true));
        expect(plan.resources.IdentityGroup?.action).toBe("replace");
        expect(plan.resources.IdentityVpc?.action).toBe(
          scenario === "upstream VPC replacement" ? "replace" : "noop",
        );
        if (scenario === "new destination VPC") {
          expect(plan.resources.DestinationVpc?.action).toBe("create");
        }
        expect(plan.resources.ConsumerInterface?.action).toBe("create");
        const moved = yield* stack.deploy(program(true));
        expect(moved.group.groupId).not.toBe(created.group.groupId);
        expect(moved.destination.vpcId).not.toBe(created.destination.vpcId);
        expect(moved.group.vpcId).toBe(moved.destination.vpcId);
        const observed = (yield* EC2.describeNetworkInterfaces({
          NetworkInterfaceIds: [moved.eni!.networkInterfaceId],
        })).NetworkInterfaces?.[0];
        expect(observed?.VpcId).toBe(moved.destination.vpcId);
        expect(observed?.SubnetId).toBe(moved.subnet!.subnetId);
        expect(observed?.Groups?.map((group) => group.GroupId)).toEqual([
          moved.group.groupId,
        ]);
        if (scenario === "new destination VPC") {
          expect(
            (yield* findDefaultGroup(created.original.vpcId)).GroupId,
          ).toBe(created.group.groupId);
          expect(yield* readRules(created.group.groupId)).toEqual(oldRules);
        } else {
          yield* assertVpcGone(created.original.vpcId);
        }
        const noop = yield* stack.plan(program(true));
        expect(noop.resources.IdentityGroup?.action).toBe("noop");
        expect(noop.resources.ConsumerInterface?.action).toBe("noop");
        yield* stack.destroy();
        yield* assertVpcGone(created.original.vpcId);
        yield* assertVpcGone(moved.destination.vpcId);
      }).pipe(logLevel),
    { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
  );
}

test.provider(
  "manages group and prefix-list sources and rejects invalid rules without writes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (
        description?: string,
        directions?: {
          ingress: SecurityGroupRuleData[];
          egress: SecurityGroupRuleData[];
        },
      ) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("SourcesVpc", { cidrBlock: "10.54.0.0/16" });
          const peer = yield* SecurityGroup("SourcePeer", {
            vpcId: vpc.vpcId,
            egress: [],
          });
          const prefix = yield* PrefixList("SourcePrefix", {
            maxEntries: 1,
            entries: [{ cidr: "10.54.0.0/16" }],
          });
          const rule = {
            ipProtocol: "tcp",
            fromPort: 443,
            toPort: 443,
            referencedGroupId: peer.groupId,
            prefixListId: prefix.prefixListId,
            description,
          };
          const group = yield* DefaultSecurityGroup("SourcesGroup", {
            vpcId: vpc.vpcId,
            ingress: directions?.ingress ?? [rule],
            egress: directions?.egress ?? [rule],
          });
          return { vpc, peer, prefix, group };
        });
      const created = yield* stack.deploy(program("Before"));
      const groupId = created.group.groupId;
      yield* Effect.gen(function* () {
        const initial = yield* readRules(groupId);
        expect(initial).toHaveLength(4);
        for (const isEgress of [false, true]) {
          const rules = initial.filter((rule) => rule.IsEgress === isEgress);
          expect(rules).toHaveLength(2);
          expect(rules).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                ReferencedGroupInfo: expect.objectContaining({
                  GroupId: created.peer.groupId,
                }),
                Description: "Before",
              }),
              expect.objectContaining({
                PrefixListId: created.prefix.prefixListId,
                Description: "Before",
              }),
            ]),
          );
        }
        for (const description of ["After", undefined]) {
          const observer = yield* observeRuleRequests;
          yield* stack
            .deploy(program(description))
            .pipe(
              Effect.provideService(HttpClient.HttpClient, observer.client),
            );
          const rules = yield* readRules(groupId);
          expect(rules).toHaveLength(4);
          expect(rules.map((rule) => rule.SecurityGroupRuleId).sort()).toEqual(
            initial.map((rule) => rule.SecurityGroupRuleId).sort(),
          );
          for (const original of initial) {
            const rule = rules.find(
              (rule) =>
                rule.SecurityGroupRuleId === original.SecurityGroupRuleId,
            )!;
            expect(rule.IsEgress).toBe(original.IsEgress);
            expect(rule.ReferencedGroupInfo?.GroupId).toBe(
              original.ReferencedGroupInfo?.GroupId,
            );
            expect(rule.PrefixListId).toBe(original.PrefixListId);
            expect(rule.Description ?? "").toBe(description ?? "");
          }
          const writes = observer.requests.filter((request) => request.write);
          expect(writes.length).toBeGreaterThan(0);
          expect(
            writes.every(
              (request) => request.action === "ModifySecurityGroupRules",
            ),
          ).toBe(true);
          expect(
            [...new Set(writes.flatMap((request) => request.ruleIds))].sort(),
          ).toEqual(initial.map((rule) => rule.SecurityGroupRuleId).sort());
        }
        const settled = yield* readRules(groupId);
        const invalid: Array<{
          rules: SecurityGroupRuleData[];
          message: string;
        }> = [
          {
            rules: [
              {
                ipProtocol: "tcp",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.54.0.7/16",
                description: "one",
              },
              {
                ipProtocol: "6",
                fromPort: 443,
                toPort: 443,
                cidrIpv4: "10.54.0.0/16",
                description: "two",
              },
            ],
            message: "Duplicate rules must have the same description.",
          },
          {
            rules: [{ ipProtocol: "tcp", fromPort: 443, toPort: 443 }],
            message: "Every rule must specify a protocol and a source.",
          },
          {
            rules: [{ ipProtocol: "", cidrIpv4: "10.54.0.0/16" }],
            message: "Every rule must specify a protocol and a source.",
          },
        ];
        for (const { rules, message } of invalid) {
          const observer = yield* observeRuleRequests;
          const error = yield* stack
            .deploy(program(undefined, { ingress: [], egress: rules }))
            .pipe(
              Effect.provideService(HttpClient.HttpClient, observer.client),
              Effect.flip,
            );
          expect(error).toMatchObject({
            _tag: "InvalidDefaultSecurityGroupRules",
            message,
          });
          expect(observer.requests.filter((request) => request.write)).toEqual(
            [],
          );
          expect(yield* readRules(groupId)).toEqual(
            expect.arrayContaining(settled),
          );
          expect(yield* readRules(groupId)).toHaveLength(settled.length);
        }
        expect(
          (yield* stack.plan(program())).resources.SourcesGroup?.action,
        ).toBe("noop");
      }).pipe(
        // Release source references even when an assertion fails before teardown.
        Effect.ensuring(
          stack
            .deploy(program(undefined, { ingress: [], egress: [] }))
            .pipe(Effect.ignore),
        ),
      );
      expect(yield* readRules(groupId)).toEqual([]);
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
      const prefixGone = yield* EC2.describeManagedPrefixLists({
        PrefixListIds: [created.prefix.prefixListId],
      }).pipe(
        Effect.map((result) =>
          (result.PrefixLists ?? []).every(
            (list) => list.State === "delete-complete",
          ),
        ),
        Effect.catchTag("InvalidPrefixListID.NotFound", () =>
          Effect.succeed(true),
        ),
        Effect.repeat({
          until: Boolean,
          schedule: Schedule.spaced("1 second"),
          times: 8,
        }),
      );
      expect(prefixGone).toBe(true);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

test.provider(
  "uses inline defaults on omission, property removal, and explicit undefined",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (
        rules: Pick<DefaultSecurityGroupProps, "ingress" | "egress"> = {},
      ) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultsVpc", { cidrBlock: "10.55.0.0/16" });
          const group = yield* DefaultSecurityGroup("DefaultsGroup", {
            vpcId: vpc.vpcId,
            ...rules,
          });
          return { vpc, group };
        });
      const created = yield* stack.deploy(program());
      const groupId = created.group.groupId;
      expect((yield* findDefaultGroup(created.vpc.vpcId)).GroupId).toBe(
        groupId,
      );
      yield* expectRules(
        groupId,
        [],
        [{ IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" }],
      );
      expect(created.group.ingressRules).toEqual([]);
      expect(created.group.egressRules).toHaveLength(1);

      const custom = [
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIpv4: "10.55.0.0/16",
        },
      ];
      yield* stack.deploy(program({ ingress: custom, egress: custom }));
      expect(yield* readRules(groupId)).toHaveLength(2);
      yield* stack.deploy(program());
      yield* expectRules(
        groupId,
        [],
        [{ IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" }],
      );
      for (const defaults of [{}, { ingress: undefined, egress: undefined }]) {
        yield* stack.deploy(program({ ingress: [], egress: [] }));
        yield* expectRules(groupId, [], []);
        const restored = yield* stack.deploy(program(defaults));
        expect(restored.group.groupId).toBe(groupId);
        yield* expectRules(
          groupId,
          [],
          [{ IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" }],
        );
      }
      const observer = yield* observeRuleRequests;
      yield* Effect.gen(function* () {
        expect(
          (yield* stack.plan(program())).resources.DefaultsGroup?.action,
        ).toBe("noop");
        yield* stack.deploy(program());
      }).pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
      expect(observer.requests.length).toBeGreaterThan(0);
      expect(observer.requests.filter((request) => request.write)).toEqual([]);
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

test.provider(
  "repairs unchanged omitted defaults and adopts them without restoring AWS self-ingress",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (vpcId?: VpcId) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("DefaultDriftVpc", {
            cidrBlock: "10.56.0.0/16",
          });
          const group = yield* DefaultSecurityGroup("DefaultDriftGroup", {
            vpcId: vpcId ?? vpc.vpcId,
          });
          return { vpc, group };
        });
      const created = yield* stack.deploy(program());
      const groupId = created.group.groupId;
      const state = yield* Effect.gen(function* () {
        return yield* yield* State;
      }).pipe(Effect.provide(stack.state));
      for (const adopt of [false, true]) {
        const outbound = (yield* readRules(groupId)).filter(
          (rule) => rule.IsEgress,
        );
        yield* EC2.revokeSecurityGroupEgress({
          GroupId: groupId,
          SecurityGroupRuleIds: outbound.map(
            (rule) => rule.SecurityGroupRuleId!,
          ),
        });
        const self = yield* EC2.authorizeSecurityGroupIngress({
          GroupId: groupId,
          IpPermissions: [
            { IpProtocol: "-1", UserIdGroupPairs: [{ GroupId: groupId }] },
          ],
        });
        const rogue = yield* EC2.authorizeSecurityGroupEgress({
          GroupId: groupId,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: 25,
              ToPort: 25,
              IpRanges: [{ CidrIp: "0.0.0.0/0" }],
            },
          ],
        });
        const rogueIds = [
          ...self.SecurityGroupRules!,
          ...rogue.SecurityGroupRules!,
        ].map((rule) => rule.SecurityGroupRuleId!);
        yield* waitForRules(
          groupId,
          (rules) =>
            rules.length === 2 &&
            rogueIds.every((id) =>
              rules.some((rule) => rule.SecurityGroupRuleId === id),
            ),
        );
        if (adopt) {
          yield* state.delete({
            stack: stack.name,
            stage: stack.stage,
            fqn: "DefaultDriftGroup",
          });
        } else {
          expect(
            (yield* stack.plan(program())).resources.DefaultDriftGroup?.action,
          ).toBe("update");
        }
        const repaired = yield* stack.deploy(
          program(adopt ? created.vpc.vpcId : undefined),
        );
        expect(repaired.group.groupId).toBe(groupId);
        yield* expectRules(
          groupId,
          [],
          [{ IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" }],
        );
        expect(
          (yield* readRules(groupId)).some((rule) =>
            rogueIds.includes(rule.SecurityGroupRuleId!),
          ),
        ).toBe(false);
      }
      expect(
        (yield* stack.plan(program())).resources.DefaultDriftGroup?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertVpcGone(created.vpc.vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

for (const mode of ["omitted", "empty", "inline"] as const) {
  test.provider(
    `composes standalone ingress and egress with ${mode} inline rules`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (
          inlinePort?: number,
          description = "Standalone",
          replace = false,
          standalone = true,
        ) =>
          Effect.gen(function* () {
            const vpc = yield* Vpc("CompositionVpc", {
              cidrBlock: "10.57.0.0/16",
            });
            const port = inlinePort ?? (mode === "inline" ? 443 : undefined);
            const inline =
              port === undefined
                ? undefined
                : [
                    {
                      ipProtocol: "tcp",
                      fromPort: port,
                      toPort: port,
                      cidrIpv4: "10.57.0.0/16",
                    },
                  ];
            const group = yield* DefaultSecurityGroup("CompositionGroup", {
              vpcId: vpc.vpcId,
              ...(inline
                ? { ingress: inline, egress: inline }
                : mode === "empty"
                  ? { ingress: [], egress: [] }
                  : {}),
            });
            const ingress = standalone
              ? yield* SecurityGroupRule("CompositionIngress", {
                  group: group,
                  type: "ingress",
                  ipProtocol: "tcp",
                  fromPort: replace ? 5433 : 5432,
                  toPort: replace ? 5433 : 5432,
                  cidrIpv4: "10.57.0.0/16",
                  description,
                })
              : undefined;
            const egress = standalone
              ? yield* SecurityGroupRule("CompositionEgress", {
                  group: group,
                  type: "egress",
                  ipProtocol: "udp",
                  fromPort: replace ? 123 : 53,
                  toPort: replace ? 123 : 53,
                  cidrIpv4: "10.57.0.0/16",
                  description,
                })
              : undefined;
            return { vpc, group, ingress, egress };
          });
        const created = yield* stack.deploy(program());
        const groupId = created.group.groupId;
        const ownedIds = [
          created.ingress!.securityGroupRuleId,
          created.egress!.securityGroupRuleId,
        ];
        const initial = yield* readRules(groupId);
        expect(initial).toHaveLength(
          mode === "omitted" ? 3 : mode === "empty" ? 2 : 4,
        );
        expect(initial.filter((rule) => !rule.IsEgress)).toHaveLength(
          mode === "inline" ? 2 : 1,
        );
        expect(initial.filter((rule) => rule.IsEgress)).toHaveLength(
          mode === "empty" ? 1 : 2,
        );
        if (mode === "omitted") {
          expect(
            initial.find((rule) => rule.IpProtocol === "-1"),
          ).toMatchObject({
            IsEgress: true,
            CidrIpv4: "0.0.0.0/0",
          });
        }
        const observer = yield* observeRuleRequests;
        yield* Effect.gen(function* () {
          const plan = yield* stack.plan(program());
          expect(plan.resources.CompositionGroup?.action).toBe("noop");
          expect(plan.resources.CompositionIngress?.action).toBe("noop");
          expect(plan.resources.CompositionEgress?.action).toBe("noop");
          yield* stack.deploy(program());
        }).pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
        expect(observer.requests.length).toBeGreaterThan(0);
        expect(observer.requests.filter((request) => request.write)).toEqual(
          [],
        );

        if (mode === "inline") {
          const state = yield* Effect.gen(function* () {
            return yield* yield* State;
          }).pipe(Effect.provide(stack.state));
          const rows = yield* Effect.forEach(
            ["CompositionIngress", "CompositionEgress"],
            Effect.fn(function* (fqn: string) {
              const key = { stack: stack.name, stage: stack.stage, fqn };
              const row = yield* state.get(key);
              if (
                !row ||
                isActionState(row) ||
                (row.status !== "created" && row.status !== "updated")
              ) {
                return yield* Effect.fail(
                  new Error("Expected a persisted standalone rule"),
                );
              }
              return {
                key,
                updating: {
                  ...row,
                  status: "updating" as const,
                  old: {
                    props: row.props,
                    attr: row.attr,
                    bindings: row.bindings,
                  },
                },
              };
            }),
          );
          // Planning recognizes old.attr even before a current snapshot is available.
          yield* Effect.gen(function* () {
            for (const { key, updating } of rows) {
              yield* state.set({
                ...key,
                value: { ...updating, attr: undefined },
              });
            }
            expect(
              (yield* stack.plan(program())).resources.CompositionGroup?.action,
            ).toBe("noop");
          }).pipe(
            Effect.ensuring(
              Effect.forEach(rows, ({ key, updating }) =>
                state.set({ ...key, value: updating }),
              ).pipe(Effect.ignore),
            ),
          );
        }
        const updated = yield* stack.deploy(program(8443));
        expect([
          updated.ingress!.securityGroupRuleId,
          updated.egress!.securityGroupRuleId,
        ]).toEqual(ownedIds);
        const updatedRules = yield* readRules(groupId);
        expect(updatedRules).toHaveLength(4);
        expect(
          updatedRules.filter((rule) => rule.FromPort === 8443),
        ).toHaveLength(2);
        expect(
          updatedRules.filter((rule) =>
            ownedIds.some((id) => id === rule.SecurityGroupRuleId),
          ),
        ).toEqual(
          expect.arrayContaining(
            initial.filter((rule) =>
              ownedIds.some((id) => id === rule.SecurityGroupRuleId),
            ),
          ),
        );
        expect(
          [...updated.group.ingressRules, ...updated.group.egressRules].map(
            (rule) => rule.securityGroupRuleId,
          ),
        ).toEqual(expect.arrayContaining(ownedIds));

        const described = yield* stack.deploy(
          program(8443, "Updated standalone"),
        );
        expect([
          described.ingress!.securityGroupRuleId,
          described.egress!.securityGroupRuleId,
        ]).toEqual(ownedIds);
        const descriptions = yield* readRules(groupId);
        for (const id of ownedIds) {
          expect(
            descriptions.find((rule) => rule.SecurityGroupRuleId === id)
              ?.Description,
          ).toBe("Updated standalone");
        }
        const replaced = yield* stack.deploy(
          program(8443, "Updated standalone", true),
        );
        expect(replaced.ingress!.securityGroupRuleId).not.toBe(ownedIds[0]);
        expect(replaced.egress!.securityGroupRuleId).not.toBe(ownedIds[1]);
        const replacementRules = yield* readRules(groupId);
        expect(replacementRules).toHaveLength(4);
        expect(
          replacementRules.some((rule) =>
            ownedIds.some((id) => id === rule.SecurityGroupRuleId),
          ),
        ).toBe(false);
        expect(
          replacementRules.find(
            (rule) =>
              rule.SecurityGroupRuleId ===
              replaced.ingress!.securityGroupRuleId,
          ),
        ).toMatchObject({ IsEgress: false, FromPort: 5433, ToPort: 5433 });
        expect(
          replacementRules.find(
            (rule) =>
              rule.SecurityGroupRuleId === replaced.egress!.securityGroupRuleId,
          ),
        ).toMatchObject({ IsEgress: true, FromPort: 123, ToPort: 123 });
        expect(
          replacementRules.filter((rule) => rule.FromPort === 8443),
        ).toEqual(
          expect.arrayContaining(
            updatedRules.filter((rule) => rule.FromPort === 8443),
          ),
        );

        expect(
          (yield* stack.plan(program(8443, "Updated standalone", true, false)))
            .resources.CompositionGroup?.action,
        ).toBe("update");
        yield* stack.deploy(program(8443, "Updated standalone", true, false));
        const final = yield* readRules(groupId);
        expect(final).toHaveLength(2);
        expect(final.every((rule) => rule.FromPort === 8443)).toBe(true);

        // New standalone records must wait for the existing manager's inline update.
        const recreated = yield* stack.deploy(program(9443, "Recreated"));
        expect(recreated.ingress!.securityGroupRuleId).not.toBe(
          replaced.ingress!.securityGroupRuleId,
        );
        expect(recreated.egress!.securityGroupRuleId).not.toBe(
          replaced.egress!.securityGroupRuleId,
        );
        const recreatedRules = yield* readRules(groupId);
        expect(recreatedRules).toHaveLength(4);
        expect(
          recreatedRules.filter((rule) => rule.FromPort === 9443),
        ).toHaveLength(2);
        expect(
          recreatedRules.find(
            (rule) =>
              rule.SecurityGroupRuleId ===
              recreated.ingress!.securityGroupRuleId,
          ),
        ).toMatchObject({
          IsEgress: false,
          FromPort: 5432,
          Description: "Recreated",
        });
        expect(
          recreatedRules.find(
            (rule) =>
              rule.SecurityGroupRuleId ===
              recreated.egress!.securityGroupRuleId,
          ),
        ).toMatchObject({
          IsEgress: true,
          FromPort: 53,
          Description: "Recreated",
        });
        const noop = yield* observeRuleRequests;
        yield* stack
          .deploy(program(9443, "Recreated"))
          .pipe(Effect.provideService(HttpClient.HttpClient, noop.client));
        expect(noop.requests.length).toBeGreaterThan(0);
        expect(noop.requests.filter((request) => request.write)).toEqual([]);
        yield* stack.destroy();
        yield* assertVpcGone(created.vpc.vpcId);
      }).pipe(logLevel),
    { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
  );
}

test.provider(
  "preserves standalone replacement classification during inline updates and new rule creation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const phases = [
        {
          inlinePort: 443,
          direction: "ingress",
          directionPort: 5000,
          directionCidr: "10.59.1.0/24",
          protocol: "tcp",
          identityPort: 5432,
          identityCidr: "10.59.3.0/24",
        },
        {
          inlinePort: 8443,
          direction: "egress",
          directionPort: 5001,
          directionCidr: "10.59.2.0/24",
          protocol: "udp",
          identityPort: 5353,
          identityCidr: "10.59.4.0/24",
        },
        {
          inlinePort: 9443,
          direction: "ingress",
          directionPort: 5002,
          directionCidr: "10.59.6.0/24",
          protocol: "tcp",
          identityPort: 8444,
          identityCidr: "10.59.7.0/24",
        },
      ] as const;
      const program = (phase: 0 | 1 | 2) =>
        Effect.gen(function* () {
          const desired = phases[phase];
          const vpc = yield* Vpc("ReplacementOrderingVpc", {
            cidrBlock: "10.59.0.0/16",
          });
          const inline = [
            {
              ipProtocol: "tcp",
              fromPort: desired.inlinePort,
              toPort: desired.inlinePort,
              cidrIpv4: "10.59.0.0/16",
            },
          ];
          const group = yield* DefaultSecurityGroup(
            "ReplacementOrderingGroup",
            {
              vpcId: vpc.vpcId,
              ingress: inline,
              egress: inline,
            },
          );
          const direction = yield* SecurityGroupRule("DirectionReplacement", {
            group: group,
            type: desired.direction,
            ipProtocol: "tcp",
            fromPort: desired.directionPort,
            toPort: desired.directionPort,
            cidrIpv4: desired.directionCidr,
          });
          const identity = yield* SecurityGroupRule("IdentityReplacement", {
            group: group,
            type: "egress",
            ipProtocol: desired.protocol,
            fromPort: desired.identityPort,
            toPort: desired.identityPort,
            cidrIpv4: desired.identityCidr,
          });
          const added =
            phase === 0
              ? undefined
              : yield* SecurityGroupRule("AddedDuringReplacement", {
                  group: group,
                  type: "ingress",
                  ipProtocol: "udp",
                  fromPort: 1234,
                  toPort: 1234,
                  cidrIpv4: "10.59.5.0/24",
                });
          return { vpc, group, direction, identity, added };
        });
      let previous = yield* stack.deploy(program(0));
      const groupId = previous.group.groupId;
      const vpcId = previous.vpc.vpcId;
      const initial = yield* readRules(groupId);
      expect(initial).toHaveLength(4);
      expect(
        initial.find(
          (rule) =>
            rule.SecurityGroupRuleId === previous.direction.securityGroupRuleId,
        ),
      ).toMatchObject({
        GroupId: groupId,
        IsEgress: false,
        IpProtocol: "tcp",
        FromPort: 5000,
        ToPort: 5000,
        CidrIpv4: "10.59.1.0/24",
      });
      expect(
        initial.find(
          (rule) =>
            rule.SecurityGroupRuleId === previous.identity.securityGroupRuleId,
        ),
      ).toMatchObject({
        GroupId: groupId,
        IsEgress: true,
        IpProtocol: "tcp",
        FromPort: 5432,
        ToPort: 5432,
        CidrIpv4: "10.59.3.0/24",
      });
      const retiredIds: string[] = [];
      for (const phase of [1, 2] as const) {
        const desired = phases[phase];
        const plan = yield* stack.plan(program(phase));
        expect(plan.resources.ReplacementOrderingGroup?.action).toBe("update");
        expect(plan.resources.DirectionReplacement?.action).toBe("replace");
        expect(plan.resources.IdentityReplacement?.action).toBe("replace");
        expect(plan.resources.AddedDuringReplacement?.action).toBe(
          phase === 1 ? "create" : "noop",
        );
        retiredIds.push(
          previous.direction.securityGroupRuleId,
          previous.identity.securityGroupRuleId,
        );
        const deployed = yield* stack.deploy(program(phase));
        expect(deployed.group.groupId).toBe(groupId);
        expect(deployed.vpc.vpcId).toBe(vpcId);
        expect(deployed.direction.securityGroupRuleId).not.toBe(
          previous.direction.securityGroupRuleId,
        );
        expect(deployed.identity.securityGroupRuleId).not.toBe(
          previous.identity.securityGroupRuleId,
        );
        if (previous.added) {
          expect(deployed.added!.securityGroupRuleId).toBe(
            previous.added.securityGroupRuleId,
          );
        }
        const currentIds = [
          deployed.direction.securityGroupRuleId,
          deployed.identity.securityGroupRuleId,
          deployed.added!.securityGroupRuleId,
        ];
        const observed = yield* waitForRules(
          groupId,
          (rules) =>
            rules.length === 5 &&
            !rules.some((rule) =>
              retiredIds.includes(rule.SecurityGroupRuleId!),
            ) &&
            currentIds.every((id) =>
              rules.some((rule) => rule.SecurityGroupRuleId === id),
            ),
        );
        expect(
          observed.find(
            (rule) =>
              rule.SecurityGroupRuleId ===
              deployed.direction.securityGroupRuleId,
          ),
        ).toMatchObject({
          GroupId: groupId,
          IsEgress: desired.direction === "egress",
          IpProtocol: "tcp",
          FromPort: desired.directionPort,
          ToPort: desired.directionPort,
          CidrIpv4: desired.directionCidr,
        });
        expect(
          observed.find(
            (rule) =>
              rule.SecurityGroupRuleId ===
              deployed.identity.securityGroupRuleId,
          ),
        ).toMatchObject({
          GroupId: groupId,
          IsEgress: true,
          IpProtocol: desired.protocol,
          FromPort: desired.identityPort,
          ToPort: desired.identityPort,
          CidrIpv4: desired.identityCidr,
        });
        expect(
          observed.find(
            (rule) =>
              rule.SecurityGroupRuleId === deployed.added!.securityGroupRuleId,
          ),
        ).toMatchObject({
          GroupId: groupId,
          IsEgress: false,
          IpProtocol: "udp",
          FromPort: 1234,
          ToPort: 1234,
          CidrIpv4: "10.59.5.0/24",
        });
        const inline = observed.filter(
          (rule) => !currentIds.some((id) => id === rule.SecurityGroupRuleId),
        );
        expect(inline).toHaveLength(2);
        for (const isEgress of [false, true]) {
          expect(
            inline.find((rule) => rule.IsEgress === isEgress),
          ).toMatchObject({
            GroupId: groupId,
            IpProtocol: "tcp",
            FromPort: desired.inlinePort,
            ToPort: desired.inlinePort,
            CidrIpv4: "10.59.0.0/16",
          });
        }
        previous = deployed;
      }
      const settled = yield* readRules(groupId);
      const observer = yield* observeRuleRequests;
      yield* Effect.gen(function* () {
        const plan = yield* stack.plan(program(2));
        for (const fqn of [
          "ReplacementOrderingGroup",
          "DirectionReplacement",
          "IdentityReplacement",
          "AddedDuringReplacement",
        ]) {
          expect(plan.resources[fqn]?.action).toBe("noop");
        }
        yield* stack.deploy(program(2));
      }).pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
      expect(observer.requests.length).toBeGreaterThan(0);
      expect(observer.requests.filter((request) => request.write)).toEqual([]);
      const final = yield* readRules(groupId);
      expect(final).toHaveLength(5);
      expect(final).toEqual(expect.arrayContaining(settled));
      yield* stack.destroy();
      yield* assertVpcGone(vpcId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

test.provider(
  "rejects copied persisted-rule tags and cross-stack ownership in both directions",
  (stack) =>
    Effect.gen(function* () {
      const foreign = Core.scratchStack(
        { providers: AWS.providers(), stage: stack.stage },
        `${stack.name}-foreign`,
        "test/AWS/EC2/DefaultSecurityGroup.test.ts",
      );
      yield* foreign.destroy();
      yield* stack.destroy();
      yield* Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const vpc = yield* Vpc("OwnershipVpc", { cidrBlock: "10.58.0.0/16" });
          const group = yield* DefaultSecurityGroup("OwnershipGroup", {
            vpcId: vpc.vpcId,
            ingress: [],
            egress: [],
          });
          yield* SecurityGroupRule("TargetIngress", {
            group: group,
            type: "ingress",
            ipProtocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrIpv4: "10.58.0.0/16",
          });
          yield* SecurityGroupRule("TargetEgress", {
            group: group,
            type: "egress",
            ipProtocol: "udp",
            fromPort: 53,
            toPort: 53,
            cidrIpv4: "10.58.0.0/16",
          });
          const peer = yield* SecurityGroup("OwnershipPeer", {
            vpcId: vpc.vpcId,
            egress: [],
          });
          const ingress = yield* SecurityGroupRule("OwnedIngress", {
            groupId: peer.groupId,
            type: "ingress",
            ipProtocol: "tcp",
            fromPort: 5432,
            toPort: 5432,
            cidrIpv4: "10.58.0.0/16",
          });
          const egress = yield* SecurityGroupRule("OwnedEgress", {
            groupId: peer.groupId,
            type: "egress",
            ipProtocol: "udp",
            fromPort: 53,
            toPort: 53,
            cidrIpv4: "10.58.0.0/16",
          });
          return { vpc, group, peer, ingress, egress };
        });
        const created = yield* stack.deploy(program);
        const groupId = created.group.groupId;
        const peerRules = yield* readRules(created.peer.groupId);
        const targetRules = yield* readRules(groupId);
        expect(peerRules).toHaveLength(2);
        expect(targetRules).toHaveLength(2);
        const copiedIds: string[] = [];
        for (const isEgress of [false, true]) {
          const source = targetRules.find(
            (rule) => !!rule.IsEgress === isEgress,
          )!;
          expect(source.Tags?.some((tag) => tag.Key === "alchemy::id")).toBe(
            true,
          );
          const authorize = isEgress
            ? EC2.authorizeSecurityGroupEgress
            : EC2.authorizeSecurityGroupIngress;
          const copied = yield* authorize({
            GroupId: groupId,
            IpPermissions: [
              {
                IpProtocol: "tcp",
                FromPort: 22,
                ToPort: 22,
                IpRanges: [{ CidrIp: "0.0.0.0/0" }],
              },
            ],
            TagSpecifications: [
              { ResourceType: "security-group-rule", Tags: source.Tags },
            ],
          });
          copiedIds.push(copied.SecurityGroupRules![0]!.SecurityGroupRuleId!);
        }
        // The same logical IDs in another stack do not delegate physical rules.
        const elsewhere = yield* foreign.deploy(
          Effect.gen(function* () {
            const ingress = yield* SecurityGroupRule("OwnedIngress", {
              groupId,
              type: "ingress",
              ipProtocol: "tcp",
              fromPort: 5433,
              toPort: 5433,
              cidrIpv4: "10.58.0.0/16",
            });
            const egress = yield* SecurityGroupRule("OwnedEgress", {
              groupId,
              type: "egress",
              ipProtocol: "udp",
              fromPort: 123,
              toPort: 123,
              cidrIpv4: "10.58.0.0/16",
            });
            return { ingress, egress };
          }),
        );
        const foreignState = yield* Effect.gen(function* () {
          return yield* yield* State;
        }).pipe(Effect.provide(foreign.state));
        for (const [fqn, attrs] of [
          ["OwnedIngress", elsewhere.ingress],
          ["OwnedEgress", elsewhere.egress],
        ] as const) {
          const row = yield* foreignState.get({
            stack: foreign.name,
            stage: foreign.stage,
            fqn,
          });
          if (!row || isActionState(row)) {
            return yield* Effect.fail(
              new Error("Expected a persisted cross-stack rule"),
            );
          }
          expect(row.attr?.securityGroupRuleId).toBe(attrs.securityGroupRuleId);
          expect(row.attr?.groupId).toBe(groupId);
        }
        const unownedIds = [
          ...copiedIds,
          elsewhere.ingress.securityGroupRuleId,
          elsewhere.egress.securityGroupRuleId,
        ];
        yield* waitForRules(
          groupId,
          (rules) =>
            rules.length === 6 &&
            unownedIds.every((id) =>
              rules.some((rule) => rule.SecurityGroupRuleId === id),
            ),
        );
        expect(
          (yield* stack.plan(program)).resources.OwnershipGroup?.action,
        ).toBe("update");
        const repaired = yield* stack.deploy(program);
        expect(yield* readRules(groupId)).toHaveLength(2);
        expect(yield* readRules(groupId)).toEqual(
          expect.arrayContaining(targetRules),
        );
        expect(repaired.group.ingressRules).toHaveLength(1);
        expect(repaired.group.egressRules).toHaveLength(1);
        expect(
          [...repaired.group.ingressRules, ...repaired.group.egressRules]
            .map((rule) => rule.securityGroupRuleId)
            .sort(),
        ).toEqual(targetRules.map((rule) => rule.SecurityGroupRuleId).sort());
        expect(yield* readRules(created.peer.groupId)).toEqual(
          expect.arrayContaining(peerRules),
        );
        expect(yield* readRules(created.peer.groupId)).toHaveLength(2);
        const observer = yield* observeRuleRequests;
        yield* Effect.gen(function* () {
          expect(
            (yield* stack.plan(program)).resources.OwnershipGroup?.action,
          ).toBe("noop");
          yield* stack.deploy(program);
        }).pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
        expect(observer.requests.length).toBeGreaterThan(0);
        expect(observer.requests.filter((request) => request.write)).toEqual(
          [],
        );
        yield* foreign.destroy();
        yield* stack.destroy();
        yield* assertVpcGone(created.vpc.vpcId);
      }).pipe(Effect.ensuring(foreign.destroy().pipe(Effect.ignore)));
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

for (const kind of ["default", "custom"] as const) {
  test.provider(
    `normalizes standalone input forms and ignores unrelated ${kind} group attributes`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (
          form:
            | "id"
            | "resource"
            | "attributes"
            | "flatMap-id"
            | "flatMap-resource"
            | "both"
            | "neither",
          description = "Standalone",
          inlineDescription = "Inline",
          move = false,
        ) =>
          Effect.gen(function* () {
            const vpc = yield* Vpc("InputFormsVpc", {
              cidrBlock: "10.60.0.0/16",
            });
            const props = {
              vpcId: vpc.vpcId,
              ingress: [
                {
                  ipProtocol: "tcp",
                  fromPort: 443,
                  toPort: 443,
                  cidrIpv4: "10.60.0.0/16",
                  description: inlineDescription,
                },
              ],
              egress: [],
            };
            const group =
              kind === "default"
                ? yield* DefaultSecurityGroup("InputFormsGroup", props)
                : yield* SecurityGroup("InputFormsGroup", props);
            const peer = yield* SecurityGroup("InputFormsPeer", {
              vpcId: vpc.vpcId,
              ingress: [],
              egress: [],
            });
            const targetGroup = move ? peer : group;
            const target =
              form === "id"
                ? { groupId: targetGroup.groupId }
                : form === "resource"
                  ? { group: targetGroup }
                  : form === "attributes"
                    ? { group: { groupId: targetGroup.groupId } }
                    : form === "flatMap-id"
                      ? {
                          groupId: vpc.vpcId.pipe(
                            Output.flatMap(() => targetGroup.groupId),
                          ),
                        }
                      : form === "flatMap-resource"
                        ? {
                            group: vpc.vpcId.pipe(
                              Output.flatMap(() => Output.of(targetGroup)),
                            ),
                          }
                        : form === "both"
                          ? { group: targetGroup, groupId: targetGroup.groupId }
                          : {};
            const rule = yield* SecurityGroupRule("InputFormsRule", {
              ...target,
              type: "egress",
              ipProtocol: "tcp",
              fromPort: 5432,
              toPort: 5432,
              cidrIpv4: "10.60.0.0/16",
              description,
              tags: { purpose: description },
            });
            return { vpc, group, peer, rule };
          });
        const created = yield* stack.deploy(program("id"));
        const groupId = created.group.groupId;
        const ruleId = created.rule.securityGroupRuleId;
        const initial = yield* readRules(groupId);
        for (const form of [
          "flatMap-id",
          "id",
          "flatMap-resource",
          "resource",
          "attributes",
          "id",
        ] as const) {
          const observer = yield* observeRuleRequests;
          yield* Effect.gen(function* () {
            const plan = yield* stack.plan(program(form));
            expect(plan.resources.InputFormsGroup?.action).toBe("noop");
            expect(plan.resources.InputFormsRule?.action).toBe("noop");
            const deployed = yield* stack.deploy(program(form));
            expect(deployed.rule.securityGroupRuleId).toBe(ruleId);
            expect(deployed.rule.groupId).toBe(groupId);
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, observer.client),
          );
          expect(observer.requests.length).toBeGreaterThan(0);
          expect(observer.requests.filter((request) => request.write)).toEqual(
            [],
          );
          const rules = yield* readRules(groupId);
          expect(rules).toEqual(expect.arrayContaining(initial));
          expect(rules).toHaveLength(2);
          expect(
            rules.find((rule) => rule.SecurityGroupRuleId === ruleId),
          ).toMatchObject({
            GroupId: groupId,
            SecurityGroupRuleId: ruleId,
            IsEgress: true,
            FromPort: 5432,
            ToPort: 5432,
          });
        }
        for (const form of ["both", "neither"] as const) {
          const observer = yield* observeRuleRequests;
          const error = yield* stack
            .plan(program(form))
            .pipe(
              Effect.provideService(HttpClient.HttpClient, observer.client),
              Effect.flip,
            );
          expect(error).toMatchObject({
            _tag: "InvalidSecurityGroupRuleGroup",
            message: "Specify exactly one of group or groupId.",
          });
          expect(observer.requests.filter((request) => request.write)).toEqual(
            [],
          );
        }
        expect(
          (yield* stack.plan(program("resource", "Updated"))).resources
            .InputFormsRule?.action,
        ).toBe("update");
        const updated = yield* stack.deploy(program("resource", "Updated"));
        expect(updated.rule.securityGroupRuleId).toBe(ruleId);
        const observed = (yield* readRules(groupId)).find(
          (rule) => rule.SecurityGroupRuleId === ruleId,
        )!;
        expect(observed.Description).toBe("Updated");
        expect(observed.Tags).toEqual(
          expect.arrayContaining([{ Key: "purpose", Value: "Updated" }]),
        );
        const observer = yield* observeRuleRequests;
        yield* Effect.gen(function* () {
          const plan = yield* stack.plan(
            program("resource", "Updated", "Changed inline"),
          );
          expect(plan.resources.InputFormsGroup?.action).toBe("update");
          expect(plan.resources.InputFormsRule?.action).toBe("noop");
          const deployed = yield* stack.deploy(
            program("resource", "Updated", "Changed inline"),
          );
          expect(deployed.rule.securityGroupRuleId).toBe(ruleId);
        }).pipe(Effect.provideService(HttpClient.HttpClient, observer.client));
        const writes = observer.requests.filter((request) => request.write);
        expect(writes.length).toBeGreaterThan(0);
        expect(
          writes.every(
            (request) => request.action === "ModifySecurityGroupRules",
          ),
        ).toBe(true);
        expect(writes.flatMap((request) => request.ruleIds)).not.toContain(
          ruleId,
        );
        expect(
          (yield* readRules(groupId)).find(
            (rule) => rule.SecurityGroupRuleId === ruleId,
          ),
        ).toEqual(observed);
        for (const form of ["resource", "id"] as const) {
          const noop = yield* observeRuleRequests;
          yield* Effect.gen(function* () {
            expect(
              (yield* stack.plan(program(form, "Updated", "Changed inline")))
                .resources.InputFormsRule?.action,
            ).toBe("noop");
            yield* stack.deploy(program(form, "Updated", "Changed inline"));
          }).pipe(Effect.provideService(HttpClient.HttpClient, noop.client));
          expect(noop.requests.length).toBeGreaterThan(0);
          expect(noop.requests.filter((request) => request.write)).toEqual([]);
        }
        // A current declaration targeting another group no longer delegates its old ID.
        for (const form of ["flatMap-id", "flatMap-resource"] as const) {
          const movePlan = yield* stack.plan(
            program(form, "Updated", "Changed inline", true),
          );
          expect(movePlan.resources.InputFormsGroup?.action).toBe("update");
          expect(movePlan.resources.InputFormsRule?.action).toBe("replace");
        }
        const moving = program(
          kind === "default" ? "resource" : "id",
          "Updated",
          "Changed inline",
          true,
        );
        const movePlan = yield* stack.plan(moving);
        expect(movePlan.resources.InputFormsGroup?.action).toBe("update");
        expect(movePlan.resources.InputFormsRule?.action).toBe("replace");
        const moved = yield* stack.deploy(moving);
        expect(moved.rule.groupId).toBe(moved.peer.groupId);
        expect(moved.rule.securityGroupRuleId).not.toBe(ruleId);
        const remaining = yield* readRules(groupId);
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.FromPort).toBe(443);
        expect(remaining[0]?.Description).toBe("Changed inline");
        const peerRules = yield* readRules(moved.peer.groupId);
        expect(peerRules).toHaveLength(1);
        expect(peerRules[0]).toMatchObject({
          SecurityGroupRuleId: moved.rule.securityGroupRuleId,
          IsEgress: true,
          FromPort: 5432,
          ToPort: 5432,
        });
        yield* stack.destroy();
        yield* assertVpcGone(created.vpc.vpcId);
      }).pipe(logLevel),
    { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
  );
}

for (const scenario of [
  "new destination VPC",
  "upstream VPC replacement",
] as const) {
  test.provider(
    `replaces whole-group standalone rules during ${scenario}`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (move: boolean) =>
          Effect.gen(function* () {
            const original = yield* Vpc("RuleIdentityVpc", {
              cidrBlock:
                move && scenario === "upstream VPC replacement"
                  ? "10.62.0.0/16"
                  : "10.61.0.0/16",
            });
            const destination =
              move && scenario === "new destination VPC"
                ? yield* Vpc("RuleDestinationVpc", {
                    cidrBlock: "10.62.0.0/16",
                  })
                : original;
            const group = yield* DefaultSecurityGroup("RuleIdentityGroup", {
              vpcId: destination.vpcId,
              ingress: [],
              egress: [],
            });
            const ingress = yield* SecurityGroupRule("MovingIngress", {
              group,
              type: "ingress",
              ipProtocol: "tcp",
              fromPort: 443,
              toPort: 443,
              cidrIpv4: "10.61.0.0/16",
            });
            const egress = yield* SecurityGroupRule("MovingEgress", {
              group,
              type: "egress",
              ipProtocol: "udp",
              fromPort: 53,
              toPort: 53,
              cidrIpv4: "10.61.0.0/16",
            });
            return { original, destination, group, ingress, egress };
          });
        const created = yield* stack.deploy(program(false));
        const plan = yield* stack.plan(program(true));
        for (const fqn of [
          "RuleIdentityGroup",
          "MovingIngress",
          "MovingEgress",
        ]) {
          expect(plan.resources[fqn]?.action).toBe("replace");
        }
        const moved = yield* stack.deploy(program(true));
        expect(moved.group.groupId).not.toBe(created.group.groupId);
        expect(moved.ingress.securityGroupRuleId).not.toBe(
          created.ingress.securityGroupRuleId,
        );
        expect(moved.egress.securityGroupRuleId).not.toBe(
          created.egress.securityGroupRuleId,
        );
        expect(moved.ingress.groupId).toBe(moved.group.groupId);
        expect(moved.egress.groupId).toBe(moved.group.groupId);
        yield* expectRules(
          moved.group.groupId,
          [
            {
              SecurityGroupRuleId: moved.ingress.securityGroupRuleId,
              IsEgress: false,
              IpProtocol: "tcp",
              FromPort: 443,
              ToPort: 443,
              CidrIpv4: "10.61.0.0/16",
            },
          ],
          [
            {
              SecurityGroupRuleId: moved.egress.securityGroupRuleId,
              IsEgress: true,
              IpProtocol: "udp",
              FromPort: 53,
              ToPort: 53,
              CidrIpv4: "10.61.0.0/16",
            },
          ],
        );
        if (scenario === "new destination VPC") {
          yield* expectRules(created.group.groupId, [], []);
        } else {
          yield* assertVpcGone(created.original.vpcId);
        }
        const noop = yield* stack.plan(program(true));
        for (const fqn of [
          "RuleIdentityGroup",
          "MovingIngress",
          "MovingEgress",
        ]) {
          expect(noop.resources[fqn]?.action).toBe("noop");
        }
        yield* stack.destroy();
        yield* assertVpcGone(created.original.vpcId);
        yield* assertVpcGone(moved.destination.vpcId);
      }).pipe(logLevel),
    { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
  );
}

const observeRuleRequests = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const requests: Array<{ action: string; write: boolean; ruleIds: string[] }> =
    [];
  return {
    requests,
    client: client.pipe(
      HttpClient.tapRequest((request) =>
        Effect.sync(() => {
          if (request.body._tag !== "Uint8Array") return;
          const parameters = new URLSearchParams(
            new TextDecoder().decode(request.body.body),
          );
          const action = parameters.get("Action");
          if (
            !action ||
            (!action.includes("SecurityGroup") &&
              action !== "CreateTags" &&
              action !== "DeleteTags")
          )
            return;
          requests.push({
            action,
            write: !action.startsWith("Describe"),
            ruleIds: [...parameters.entries()]
              .filter(
                ([key]) =>
                  key.endsWith(".SecurityGroupRuleId") ||
                  key.startsWith("SecurityGroupRuleId."),
              )
              .map(([, value]) => value),
          });
        }),
      ),
    ),
  };
});

const waitForRules = Effect.fn(function* (
  groupId: string,
  matches: (rules: EC2.SecurityGroupRule[]) => boolean,
) {
  const rules = yield* readRules(groupId).pipe(
    Effect.repeat({
      until: matches,
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
  expect(matches(rules)).toBe(true);
  return rules;
});

const findDefaultGroup = Effect.fn(function* (vpcId: string) {
  const group = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  }).pipe(
    Effect.map((result) => result.SecurityGroups?.[0]),
    Effect.repeat({
      until: (group) => !!group?.GroupId,
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
  if (!group?.GroupId) {
    return yield* Effect.fail(
      new Error(`Default group for ${vpcId} was not found`),
    );
  }
  return group;
});

const readRules = (groupId: string) =>
  EC2.describeSecurityGroupRules
    .items({ Filters: [{ Name: "group-id", Values: [groupId] }] })
    .pipe(
      Stream.runCollect,
      Effect.map((rules) => Array.from(rules)),
    );

const expectRules = Effect.fn(function* (
  groupId: string,
  ingress: Partial<EC2.SecurityGroupRule>[],
  egress: Partial<EC2.SecurityGroupRule>[],
) {
  const rules = yield* readRules(groupId);
  expect(rules.filter((rule) => !rule.IsEgress)).toEqual(
    ingress.map((rule) => expect.objectContaining(rule)),
  );
  expect(rules.filter((rule) => rule.IsEgress)).toEqual(
    egress.map((rule) => expect.objectContaining(rule)),
  );
});
