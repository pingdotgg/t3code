import * as AWS from "@/AWS";
import { ResolverEndpoint, ResolverRule } from "@/AWS/Route53Resolver";
import * as Test from "@/Test/Alchemy";
import * as r53r from "@distilled.cloud/aws/route53resolver";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertEndpointDeleting,
  assertRuleGone,
  defaultNetwork,
} from "./helpers.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "forward rule lifecycle: create, update target IPs, replace on domain change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const net = yield* defaultNetwork;
      const make = (targetIp: string, domainName: string) =>
        Effect.gen(function* () {
          const endpoint = yield* ResolverEndpoint("Outbound", {
            direction: "OUTBOUND",
            securityGroupIds: [net.securityGroupId],
            ipAddresses: net.subnetIds.map((subnetId) => ({ subnetId })),
          });
          const rule = yield* ResolverRule("Forward", {
            domainName,
            resolverEndpointId: endpoint.resolverEndpointId,
            targetIps: [{ ip: targetIp }],
            tags: { fixture: "r53r-rule" },
          });
          return { endpoint, rule };
        });

      const deployed = yield* stack.deploy(
        make("192.168.10.10", "corp.alchemy-r53r-test.internal"),
      );

      expect(deployed.endpoint.resolverEndpointId).toMatch(/^rslvr-out-/);
      expect(deployed.rule.resolverRuleId).toMatch(/^rslvr-rr-/);
      expect(deployed.rule.resolverRuleArn).toContain(":resolver-rule/");
      expect(deployed.rule.domainName.replace(/\.$/, "")).toBe(
        "corp.alchemy-r53r-test.internal",
      );

      // Out-of-band: the rule forwards to the target through the endpoint.
      const rule = yield* r53r.getResolverRule({
        ResolverRuleId: deployed.rule.resolverRuleId,
      });
      expect(rule.ResolverRule?.RuleType).toBe("FORWARD");
      expect(rule.ResolverRule?.ResolverEndpointId).toBe(
        deployed.endpoint.resolverEndpointId,
      );
      expect(rule.ResolverRule?.TargetIps?.map((t) => t.Ip)).toEqual([
        "192.168.10.10",
      ]);
      const tags = yield* r53r.listTagsForResource({
        ResourceArn: deployed.rule.resolverRuleArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.fixture).toBe("r53r-rule");
      expect(tagRecord["alchemy::id"]).toBe("Forward");

      // In-place update: change the target IP — same rule (no replacement).
      const updated = yield* stack.deploy(
        make("192.168.10.11", "corp.alchemy-r53r-test.internal"),
      );
      expect(updated.rule.resolverRuleId).toBe(deployed.rule.resolverRuleId);
      const afterUpdate = yield* r53r.getResolverRule({
        ResolverRuleId: deployed.rule.resolverRuleId,
      });
      expect(afterUpdate.ResolverRule?.TargetIps?.map((t) => t.Ip)).toEqual([
        "192.168.10.11",
      ]);

      // Replacement: change the domain name — new rule, old rule deleted.
      const replaced = yield* stack.deploy(
        make("192.168.10.11", "corp2.alchemy-r53r-test.internal"),
      );
      expect(replaced.rule.resolverRuleId).not.toBe(
        deployed.rule.resolverRuleId,
      );
      expect(replaced.rule.domainName.replace(/\.$/, "")).toBe(
        "corp2.alchemy-r53r-test.internal",
      );
      yield* assertRuleGone(deployed.rule.resolverRuleId);

      yield* stack.destroy();
      yield* assertRuleGone(replaced.rule.resolverRuleId);
      yield* assertEndpointDeleting(replaced.endpoint.resolverEndpointId);
    }),
  { timeout: 220_000 },
);
