import * as AWS from "@/AWS";
import { Subnet } from "@/AWS/EC2";
import { Listener, ListenerRule, LoadBalancer, TargetGroup } from "@/AWS/ELBv2";
import * as Test from "@/Test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Create a path-pattern rule and a host-header rule on a listener, update the
// path rule's condition + action in place, change its priority via
// setRulePriorities, then destroy. Reuses the default VPC + carved subnets.
test.provider(
  "listener rules: path + host conditions, in-place update, priority change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const azResult = yield* EC2.describeAvailabilityZones({});
      const azs =
        azResult.AvailabilityZones?.filter(
          (az) => az.State === "available",
        ).flatMap((az) => (az.ZoneName ? [az.ZoneName] : [])) ?? [];
      const [az1, az2] = azs;
      expect(az1).toBeTruthy();
      expect(az2).toBeTruthy();

      const defaultVpc = yield* getDefaultVpc;

      const stage = (
        pathPriority: number,
        pathValue: string,
        pathTargetFixed: boolean,
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            const subnet1 = yield* Subnet("RSubnet1", {
              vpcId: defaultVpc.vpcId,
              // ListenerActions runs in another file and owns 226/227.
              // Keep a distinct deterministic pair so file concurrency
              // cannot turn subnet CIDR conflicts into whole-test retries.
              cidrBlock: defaultVpc.subnetCidrBlock(228),
              availabilityZone: az1,
            });
            const subnet2 = yield* Subnet("RSubnet2", {
              vpcId: defaultVpc.vpcId,
              cidrBlock: defaultVpc.subnetCidrBlock(229),
              availabilityZone: az2,
            });
            const lb = yield* LoadBalancer("RLb", {
              subnets: [subnet1.subnetId, subnet2.subnetId],
              scheme: "internal",
              type: "application",
            });
            const tg = yield* TargetGroup("RTg", {
              vpcId: defaultVpc.vpcId,
              port: 80,
              protocol: "HTTP",
              targetType: "ip",
            });
            const listener = yield* Listener("RListener", {
              loadBalancerArn: lb.loadBalancerArn,
              targetGroupArn: tg.targetGroupArn,
              port: 80,
              protocol: "HTTP",
            });
            const pathRule = yield* ListenerRule("RPathRule", {
              listenerArn: listener.listenerArn,
              priority: pathPriority,
              conditions: [{ pathPattern: { values: [pathValue] } }],
              actions: pathTargetFixed
                ? [
                    {
                      type: "fixedResponse",
                      statusCode: "200",
                      messageBody: "ok",
                    },
                  ]
                : [
                    {
                      type: "forward",
                      targetGroups: [{ targetGroupArn: tg.targetGroupArn }],
                    },
                  ],
            });
            const hostRule = yield* ListenerRule("RHostRule", {
              listenerArn: listener.listenerArn,
              priority: 20,
              conditions: [{ hostHeader: { values: ["admin.example.com"] } }],
              actions: [
                {
                  type: "forward",
                  targetGroups: [{ targetGroupArn: tg.targetGroupArn }],
                },
              ],
            });
            return {
              pathRuleArn: pathRule.ruleArn,
              hostRuleArn: hostRule.ruleArn,
            };
          }),
        );

      // STAGE 1: path rule priority 10 forwarding "/api/*", host rule priority 20.
      const s1 = yield* stage(10, "/api/*", false);
      const pathRuleArn = s1.pathRuleArn;

      const describePath = elbv2
        .describeRules({ RuleArns: [pathRuleArn] })
        .pipe(Effect.map((r) => r.Rules?.[0]));

      let rule = yield* describePath;
      expect(rule?.Priority).toBe("10");
      expect(rule?.Conditions?.[0]?.Field).toBe("path-pattern");
      expect(rule?.Conditions?.[0]?.PathPatternConfig?.Values).toEqual([
        "/api/*",
      ]);
      expect(rule?.Actions?.some((x) => x.Type === "forward")).toBe(true);

      // STAGE 2: change the path value + action (forward -> fixedResponse) in
      // place, and bump priority 10 -> 15 via setRulePriorities.
      yield* stage(15, "/v2/*", true);

      rule = yield* describePath;
      expect(rule?.Priority).toBe("15");
      expect(rule?.Conditions?.[0]?.PathPatternConfig?.Values).toEqual([
        "/v2/*",
      ]);
      expect(rule?.Actions?.some((x) => x.Type === "fixed-response")).toBe(
        true,
      );

      yield* stack.destroy();

      const after = yield* elbv2
        .describeRules({ RuleArns: [pathRuleArn] })
        .pipe(
          Effect.map((r) => r.Rules?.length ?? 0),
          Effect.catchTag("RuleNotFoundException", () => Effect.succeed(0)),
        );
      expect(after).toBe(0);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
