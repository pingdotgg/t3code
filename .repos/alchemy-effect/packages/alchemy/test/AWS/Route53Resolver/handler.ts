import * as Lambda from "@/AWS/Lambda";
import * as Route53Resolver from "@/AWS/Route53Resolver";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { getDefaultVpc } from "../DefaultVpc.ts";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class Route53ResolverBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "Route53ResolverBindingsFunction",
) {}

/**
 * Resolve two default-for-AZ subnets plus the default security group from
 * the account's default VPC — the network the resolver endpoint's interfaces
 * land in. Runtime-guarded: the Lambda runtime re-executes this props effect
 * on cold start with no ec2:Describe* permission, so return empty values
 * there (network config is deploy-time only).
 */
const resolveNetwork = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) {
    return { subnetIds: [] as string[], securityGroupIds: [] as string[] };
  }
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is string => id !== undefined)
    .sort()
    .slice(0, 2);
  const groups = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const securityGroupId = groups.SecurityGroups?.[0]?.GroupId;
  return {
    subnetIds,
    securityGroupIds: securityGroupId ? [securityGroupId] : [],
  };
}).pipe(
  // Deploy-time lookup only; a failure here is a fixture defect, not a typed
  // error the Function impl contract can carry.
  Effect.orDie,
);

/**
 * Binding fixture: an OUTBOUND resolver endpoint in the default VPC, a
 * FORWARD rule through it, and a Lambda bound to all five Route 53 Resolver
 * runtime bindings, one HTTP route per behavior.
 */
export default Route53ResolverBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const net = yield* resolveNetwork;
    const endpoint = yield* Route53Resolver.ResolverEndpoint(
      "BindingsEndpoint",
      {
        direction: "OUTBOUND",
        securityGroupIds: net.securityGroupIds,
        ipAddresses: net.subnetIds.map((subnetId) => ({ subnetId })),
      },
    );
    const rule = yield* Route53Resolver.ResolverRule("BindingsRule", {
      domainName: "bindings.alchemy-r53r-test.internal",
      resolverEndpointId: endpoint.resolverEndpointId,
      targetIps: [{ ip: "10.100.0.10" }],
    });

    const bound = {
      getResolverEndpoint: yield* Route53Resolver.GetResolverEndpoint(endpoint),
      listResolverEndpointIpAddresses:
        yield* Route53Resolver.ListResolverEndpointIpAddresses(endpoint),
      getResolverRule: yield* Route53Resolver.GetResolverRule(rule),
      updateResolverRule: yield* Route53Resolver.UpdateResolverRule(rule),
      listResolverRuleAssociations:
        yield* Route53Resolver.ListResolverRuleAssociations(rule),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Endpoint-scoped read — the endpoint ID is injected.
        if (request.method === "GET" && pathname === "/endpoint") {
          const response = yield* bound.getResolverEndpoint();
          return yield* HttpServerResponse.json({
            status: response.ResolverEndpoint?.Status ?? "",
            direction: response.ResolverEndpoint?.Direction ?? "",
            ipAddressCount: response.ResolverEndpoint?.IpAddressCount ?? 0,
          });
        }

        // Endpoint IP discovery — the endpoint ID is injected.
        if (request.method === "GET" && pathname === "/endpoint/ips") {
          const response = yield* bound.listResolverEndpointIpAddresses();
          return yield* HttpServerResponse.json({
            ips: (response.IpAddresses ?? []).map((ip) => ({
              ip: ip.Ip ?? "",
              status: ip.Status ?? "",
            })),
          });
        }

        // Rule-scoped read — the rule ID is injected.
        if (request.method === "GET" && pathname === "/rule") {
          const response = yield* bound.getResolverRule();
          return yield* HttpServerResponse.json({
            domainName: response.ResolverRule?.DomainName ?? "",
            ruleType: response.ResolverRule?.RuleType ?? "",
            targetIps: (response.ResolverRule?.TargetIps ?? []).map(
              (t) => t.Ip ?? "",
            ),
          });
        }

        // Runtime failover: swap the rule's target IP.
        if (request.method === "POST" && pathname === "/rule/target") {
          const ip = url.searchParams.get("ip") ?? "";
          const response = yield* bound.updateResolverRule({
            Config: { TargetIps: [{ Ip: ip, Port: 53 }] },
          });
          return yield* HttpServerResponse.json({
            status: response.ResolverRule?.Status ?? "",
            targetIps: (response.ResolverRule?.TargetIps ?? []).map(
              (t) => t.Ip ?? "",
            ),
          });
        }

        // Which VPCs is the rule live in? (filtered to the bound rule)
        if (request.method === "GET" && pathname === "/rule/associations") {
          const response = yield* bound.listResolverRuleAssociations();
          return yield* HttpServerResponse.json({
            count: (response.ResolverRuleAssociations ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Route53Resolver.GetResolverEndpointHttp,
        Route53Resolver.ListResolverEndpointIpAddressesHttp,
        Route53Resolver.GetResolverRuleHttp,
        Route53Resolver.UpdateResolverRuleHttp,
        Route53Resolver.ListResolverRuleAssociationsHttp,
      ),
    ),
  ),
);
