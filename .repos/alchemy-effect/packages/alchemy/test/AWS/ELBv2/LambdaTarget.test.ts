import * as AWS from "@/AWS";
import { SecurityGroupRule, type SecurityGroupId } from "@/AWS/EC2";
import type { SubnetId } from "@/AWS/EC2/Subnet.ts";
import {
  Listener,
  ListenerRule,
  LoadBalancer,
  TargetGroup,
  TargetGroupAttachment,
} from "@/AWS/ELBv2";
import * as Test from "@/Test/Alchemy";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import { resolve4 } from "node:dns/promises";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDefaultVpc } from "../DefaultVpc.ts";
import {
  ApiTargetFunction,
  ApiTargetFunctionLive,
} from "./fixtures/api-handler.ts";
import {
  WebTargetFunction,
  WebTargetFunctionLive,
} from "./fixtures/web-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The flagship ELBv2 e2e: one internet-facing ALB routes two path patterns to
// two different Lambda targets (no VPC targets, no NAT — Lambda targets prove
// the rule routing end-to-end). AWS kept new ALBs in `provisioning` with
// unresolvable DNS beyond the factory's bounded readiness budget under c128,
// so this slow live lifecycle is opt-in. Set AWS_TEST_SLOW=1 to run it.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "ALB routes two paths to two Lambda targets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const defaultVpc = yield* getDefaultVpc;

      // Use the default VPC's EXISTING default subnets + default SG rather
      // than creating our own. An ALB leaves ENIs that take minutes to
      // release after deletion; a stack-managed subnet/SG cannot delete until
      // those ENIs clear, which blew the whole test past its wall on
      // teardown. Pre-existing, non-stack-managed network resources are never
      // torn down, so teardown is just ALB + target groups + listener.
      const subnetResult = yield* EC2.describeSubnets({
        Filters: [
          { Name: "vpc-id", Values: [defaultVpc.vpcId] },
          { Name: "default-for-az", Values: ["true"] },
        ],
      });
      const subnetIds = (subnetResult.Subnets ?? [])
        .flatMap((s) => (s.SubnetId ? [s.SubnetId as SubnetId] : []))
        .slice(0, 2);
      expect(subnetIds.length).toBe(2);

      const groupResult = yield* EC2.describeSecurityGroups({
        Filters: [
          { Name: "vpc-id", Values: [defaultVpc.vpcId] },
          { Name: "group-name", Values: ["default"] },
        ],
      });
      const defaultGroupId = groupResult.SecurityGroups?.[0]
        ?.GroupId as SecurityGroupId;
      expect(defaultGroupId).toBeTruthy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const apiFn = yield* ApiTargetFunction.pipe(
            Effect.provide(ApiTargetFunctionLive),
          );
          const webFn = yield* WebTargetFunction.pipe(
            Effect.provide(WebTargetFunctionLive),
          );

          // Add one stack-owned ingress rule to the standing default SG. The
          // ALB uses only pre-existing network containers, so teardown does
          // not spend minutes waiting for ALB ENIs before deleting an SG.
          yield* SecurityGroupRule("LtIngress", {
            groupId: defaultGroupId,
            type: "ingress",
            ipProtocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrIpv4: "0.0.0.0/0",
            description: "Alchemy ELBv2 Lambda-target e2e",
          });

          const lb = yield* LoadBalancer("LtLb", {
            type: "application",
            scheme: "internet-facing",
            subnets: subnetIds,
            securityGroups: [defaultGroupId],
          });

          const apiTg = yield* TargetGroup("LtApiTg", {
            targetType: "lambda",
          });
          const webTg = yield* TargetGroup("LtWebTg", {
            targetType: "lambda",
          });

          // ALB validates the invoke permission at registerTargets time, so
          // each target group needs its Permission before the attachment
          // (the attachment retries briefly while the permission propagates).
          yield* AWS.Lambda.Permission("LtApiInvoke", {
            action: "lambda:InvokeFunction",
            functionName: apiFn.functionName,
            principal: "elasticloadbalancing.amazonaws.com",
            sourceArn: apiTg.targetGroupArn,
          });
          yield* AWS.Lambda.Permission("LtWebInvoke", {
            action: "lambda:InvokeFunction",
            functionName: webFn.functionName,
            principal: "elasticloadbalancing.amazonaws.com",
            sourceArn: webTg.targetGroupArn,
          });

          const apiAttachment = yield* TargetGroupAttachment("LtApiTarget", {
            targetGroupArn: apiTg.targetGroupArn,
            targetId: apiFn.functionArn,
          });
          const webAttachment = yield* TargetGroupAttachment("LtWebTarget", {
            targetGroupArn: webTg.targetGroupArn,
            targetId: webFn.functionArn,
          });

          const listener = yield* Listener("LtListener", {
            loadBalancerArn: lb.loadBalancerArn,
            port: 80,
            protocol: "HTTP",
            defaultActions: [
              {
                type: "fixedResponse",
                statusCode: "404",
                contentType: "text/plain",
                messageBody: "no rule matched",
              },
            ],
          });
          yield* ListenerRule("LtApiRule", {
            listenerArn: listener.listenerArn,
            priority: 10,
            conditions: [{ pathPattern: { values: ["/api/*"] } }],
            actions: [
              {
                type: "forward",
                targetGroups: [{ targetGroupArn: apiTg.targetGroupArn }],
              },
            ],
          });
          yield* ListenerRule("LtWebRule", {
            listenerArn: listener.listenerArn,
            priority: 20,
            conditions: [{ pathPattern: { values: ["/web/*"] } }],
            actions: [
              {
                type: "forward",
                targetGroups: [{ targetGroupArn: webTg.targetGroupArn }],
              },
            ],
          });

          return {
            dnsName: lb.dnsName,
            apiTargetGroupArn: apiAttachment.targetGroupArn,
            webTargetGroupArn: webAttachment.targetGroupArn,
            apiFunctionArn: apiAttachment.targetId,
            webFunctionArn: webAttachment.targetId,
          };
        }),
      );

      // Out-of-band: both Lambda targets are registered.
      const apiHealth = yield* elbv2.describeTargetHealth({
        TargetGroupArn: out.apiTargetGroupArn,
      });
      expect(
        apiHealth.TargetHealthDescriptions?.some(
          (d) => d.Target?.Id === out.apiFunctionArn,
        ),
      ).toBe(true);
      const webHealth = yield* elbv2.describeTargetHealth({
        TargetGroupArn: out.webTargetGroupArn,
      });
      expect(
        webHealth.TargetHealthDescriptions?.some(
          (d) => d.Target?.Id === out.webFunctionArn,
        ),
      ).toBe(true);

      // Resolve the newly-created ALB explicitly before the first HTTP
      // request. Starting fetch while its hostname is still propagating can
      // retain the negative DNS lookup for every retry in this process.
      const [albAddress] = yield* Effect.tryPromise(() =>
        resolve4(out.dnsName),
      ).pipe(
        Effect.flatMap((addresses) =>
          addresses[0]
            ? Effect.succeed(addresses)
            : Effect.fail(new Error(`ALB ${out.dnsName} has no IPv4 address`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 8 }),
      );

      // Drive both paths through the public ALB address. Keep readiness under
      // 50 seconds and probe both targets in parallel so one Lambda cold start
      // does not serialize the other.
      const getJson = (url: string) =>
        HttpClient.get(url).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(new Error(`ALB returned ${response.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 10 }),
        );

      const baseUrl = `http://${albAddress}`;
      const [apiBody, webBody] = (yield* Effect.all(
        [getJson(`${baseUrl}/api/hello`), getJson(`${baseUrl}/web/hello`)],
        { concurrency: "unbounded" },
      )) as [
        { target: string; path: string },
        { target: string; path: string },
      ];
      expect(apiBody.target).toBe("api");
      expect(apiBody.path).toBe("/api/hello");
      expect(webBody.target).toBe("web");
      expect(webBody.path).toBe("/web/hello");

      // Unmatched paths hit the listener's fixed-response default action.
      const fallback = yield* HttpClient.get(`${baseUrl}/nope`);
      expect(fallback.status).toBe(404);

      yield* stack.destroy();

      // Out-of-band: the target groups are gone after destroy.
      const after = yield* elbv2
        .describeTargetGroups({ TargetGroupArns: [out.apiTargetGroupArn] })
        .pipe(
          Effect.map((r) => r.TargetGroups?.length ?? 0),
          Effect.catchTag("TargetGroupNotFoundException", () =>
            Effect.succeed(0),
          ),
        );
      expect(after).toBe(0);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
