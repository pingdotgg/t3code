import * as Lambda from "@/AWS/Lambda";
import * as WAFv2 from "@/AWS/WAFv2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class Wafv2BindingsFunction extends Lambda.Function<Lambda.Function>()(
  "Wafv2BindingsFunction",
) {}

export default Wafv2BindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    // Cheap, fast-provisioning WAF entities that exercise every binding
    // scope: an IP set (dynamic block list), a web ACL with a rate-based
    // rule, and a rule group (permission-policy interface).
    const ipSet = yield* WAFv2.IPSet("BindingsIpSet", {
      addresses: ["192.0.2.44/32"],
      description: "bindings fixture",
    });
    const webAcl = yield* WAFv2.WebACL("BindingsAcl", {
      defaultAction: { Allow: {} },
      rules: [
        {
          Name: "rate-limit",
          Priority: 0,
          Statement: {
            RateBasedStatement: { Limit: 100, AggregateKeyType: "IP" },
          },
          Action: { Block: {} },
          VisibilityConfig: {
            SampledRequestsEnabled: true,
            CloudWatchMetricsEnabled: true,
            MetricName: "rate-limit",
          },
        },
      ],
    });
    const ruleGroup = yield* WAFv2.RuleGroup("BindingsRuleGroup", {
      capacity: 10,
    });

    // The rule group ARN accessor — resolved per-request to derive the
    // account id for the permission-policy round trip.
    const ruleGroupArn = yield* ruleGroup.ruleGroupArn;

    const bound = {
      getIPSet: yield* WAFv2.GetIPSet(ipSet),
      updateIPSet: yield* WAFv2.UpdateIPSet(ipSet),
      getSampledRequests: yield* WAFv2.GetSampledRequests(webAcl),
      getRateBasedStatementManagedKeys:
        yield* WAFv2.GetRateBasedStatementManagedKeys(webAcl),
      listResourcesForWebACL: yield* WAFv2.ListResourcesForWebACL(webAcl),
      getTopPathStatisticsByTraffic:
        yield* WAFv2.GetTopPathStatisticsByTraffic(webAcl),
      getPermissionPolicy: yield* WAFv2.GetPermissionPolicy(ruleGroup),
      putPermissionPolicy: yield* WAFv2.PutPermissionPolicy(ruleGroup),
      deletePermissionPolicy: yield* WAFv2.DeletePermissionPolicy(ruleGroup),
      checkCapacity: yield* WAFv2.CheckCapacity(),
      createAPIKey: yield* WAFv2.CreateAPIKey(),
      getDecryptedAPIKey: yield* WAFv2.GetDecryptedAPIKey(),
      listAPIKeys: yield* WAFv2.ListAPIKeys(),
      deleteAPIKey: yield* WAFv2.DeleteAPIKey(),
      describeManagedRuleGroup: yield* WAFv2.DescribeManagedRuleGroup(),
      listAvailableManagedRuleGroups:
        yield* WAFv2.ListAvailableManagedRuleGroups(),
      listAvailableManagedRuleGroupVersions:
        yield* WAFv2.ListAvailableManagedRuleGroupVersions(),
      describeAllManagedProducts: yield* WAFv2.DescribeAllManagedProducts(),
      describeManagedProductsByVendor:
        yield* WAFv2.DescribeManagedProductsByVendor(),
      getWebACLForResource: yield* WAFv2.GetWebACLForResource(),
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

        // IP-set-scoped: Name/Scope/Id injected.
        if (request.method === "GET" && pathname === "/ip-set") {
          const response = yield* bound.getIPSet();
          return yield* HttpServerResponse.json({
            addresses: [...(response.IPSet?.Addresses ?? [])].sort(),
            description: response.IPSet?.Description ?? "",
          });
        }

        // Dynamic block list: full-replacement update, LockToken handled
        // inside the binding.
        if (request.method === "POST" && pathname === "/ip-set") {
          const body = (yield* request.json) as { addresses: string[] };
          yield* bound.updateIPSet({ addresses: body.addresses });
          const after = yield* bound.getIPSet();
          return yield* HttpServerResponse.json({
            addresses: [...(after.IPSet?.Addresses ?? [])].sort(),
          });
        }

        // Web-ACL-scoped: WebAclArn + Scope injected.
        if (request.method === "GET" && pathname === "/sampled") {
          const now = yield* Effect.sync(() => new Date());
          const response = yield* bound.getSampledRequests({
            RuleMetricName: "rate-limit",
            TimeWindow: {
              StartTime: new Date(now.getTime() - 60 * 60 * 1000),
              EndTime: now,
            },
            MaxItems: 100,
          });
          return yield* HttpServerResponse.json({
            sampled: (response.SampledRequests ?? []).length,
            populationSize: response.PopulationSize ?? 0,
          });
        }

        // Web-ACL-scoped: Scope + WebACLName + WebACLId injected.
        if (request.method === "GET" && pathname === "/rate-keys") {
          const response = yield* bound.getRateBasedStatementManagedKeys({
            RuleName: "rate-limit",
          });
          return yield* HttpServerResponse.json({
            v4: (response.ManagedKeysIPV4?.Addresses ?? []).length,
            v4Version: response.ManagedKeysIPV4?.IPAddressVersion ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/resources") {
          const response = yield* bound.listResourcesForWebACL();
          return yield* HttpServerResponse.json({
            resources: response.ResourceArns ?? [],
          });
        }

        // Pricing-plan-gated: report the typed outcome instead of dying.
        if (request.method === "GET" && pathname === "/top-paths") {
          const now = yield* Effect.sync(() => new Date());
          const result = yield* Effect.result(
            bound.getTopPathStatisticsByTraffic({
              TimeWindow: {
                StartTime: new Date(now.getTime() - 60 * 60 * 1000),
                EndTime: now,
              },
              Limit: 10,
              NumberOfTopTrafficBotsPerPath: 3,
            }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? { ok: true, tag: null }
              : { ok: false, tag: result.failure._tag },
          );
        }

        // Permission-policy round trip on the rule group ARN.
        if (request.method === "GET" && pathname === "/permission-policy") {
          const before = yield* bound
            .getPermissionPolicy()
            .pipe(
              Effect.catchTag("WAFNonexistentItemException", () =>
                Effect.succeed({ Policy: undefined }),
              ),
            );
          const arn = yield* ruleGroupArn;
          const account = arn.split(":")[4];
          // The policy must NOT include a Resource parameter — the resource
          // is implied by the ResourceArn the binding injects.
          yield* bound.putPermissionPolicy({
            Policy: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { AWS: `arn:aws:iam::${account}:root` },
                  Action: [
                    "wafv2:CreateWebACL",
                    "wafv2:UpdateWebACL",
                    "wafv2:PutFirewallManagerRuleGroups",
                  ],
                },
              ],
            }),
          });
          const after = yield* bound.getPermissionPolicy();
          yield* bound.deletePermissionPolicy();
          return yield* HttpServerResponse.json({
            beforePolicy: before.Policy ?? null,
            hasPolicy: typeof after.Policy === "string",
            deleted: true,
          });
        }

        // Account-level: WCU cost of a simple geo-match rule.
        if (request.method === "GET" && pathname === "/capacity") {
          const response = yield* bound.checkCapacity({
            Scope: "REGIONAL",
            Rules: [
              {
                Name: "cap-probe",
                Priority: 0,
                Statement: { GeoMatchStatement: { CountryCodes: ["US"] } },
                Action: { Block: {} },
                VisibilityConfig: {
                  SampledRequestsEnabled: false,
                  CloudWatchMetricsEnabled: false,
                  MetricName: "cap-probe",
                },
              },
            ],
          });
          return yield* HttpServerResponse.json({
            capacity: response.Capacity ?? 0,
          });
        }

        // CAPTCHA API-key lifecycle: mint, list, decrypt, delete.
        if (request.method === "GET" && pathname === "/api-keys") {
          const created = yield* bound.createAPIKey({
            Scope: "REGIONAL",
            TokenDomains: ["example.com"],
          });
          const apiKey = created.APIKey ?? "";
          const listed = yield* bound.listAPIKeys({ Scope: "REGIONAL" });
          const decrypted = yield* bound.getDecryptedAPIKey({
            Scope: "REGIONAL",
            APIKey: apiKey,
          });
          yield* bound.deleteAPIKey({ Scope: "REGIONAL", APIKey: apiKey });
          return yield* HttpServerResponse.json({
            created: apiKey.length > 0,
            listed: (listed.APIKeySummaries ?? []).length,
            domains: decrypted.TokenDomains ?? [],
            deleted: true,
          });
        }

        // Managed rule group catalog.
        if (request.method === "GET" && pathname === "/managed") {
          const groups = yield* bound.listAvailableManagedRuleGroups({
            Scope: "REGIONAL",
            Limit: 20,
          });
          const described = yield* bound.describeManagedRuleGroup({
            VendorName: "AWS",
            Name: "AWSManagedRulesCommonRuleSet",
            Scope: "REGIONAL",
          });
          const versions = yield* bound.listAvailableManagedRuleGroupVersions({
            VendorName: "AWS",
            Name: "AWSManagedRulesCommonRuleSet",
            Scope: "REGIONAL",
            Limit: 5,
          });
          return yield* HttpServerResponse.json({
            groups: (groups.ManagedRuleGroups ?? []).length,
            capacity: described.Capacity ?? 0,
            currentDefaultVersion: versions.CurrentDefaultVersion ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/products") {
          const all = yield* bound.describeAllManagedProducts({
            Scope: "REGIONAL",
          });
          const aws = yield* bound.describeManagedProductsByVendor({
            VendorName: "AWS",
            Scope: "REGIONAL",
          });
          return yield* HttpServerResponse.json({
            all: (all.ManagedProducts ?? []).length,
            aws: (aws.ManagedProducts ?? []).length,
          });
        }

        // Look up the web ACL of a (nonexistent) ALB — the typed
        // WAFNonexistentItemException proves grant + wiring.
        if (request.method === "GET" && pathname === "/waf-for-resource") {
          const ipSetArn = (yield* bound.getIPSet()).IPSet?.ARN ?? "";
          const [, , , region, account] = ipSetArn.split(":");
          const response = yield* bound
            .getWebACLForResource({
              ResourceArn: `arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/app/wafv2-bindings-missing/0123456789abcdef`,
            })
            .pipe(
              Effect.catchTag("WAFNonexistentItemException", () =>
                Effect.succeed({ WebACL: undefined }),
              ),
            );
          return yield* HttpServerResponse.json({
            found: response.WebACL !== undefined,
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
        WAFv2.GetIPSetHttp,
        WAFv2.UpdateIPSetHttp,
        WAFv2.GetSampledRequestsHttp,
        WAFv2.GetRateBasedStatementManagedKeysHttp,
        WAFv2.ListResourcesForWebACLHttp,
        WAFv2.GetTopPathStatisticsByTrafficHttp,
        WAFv2.GetPermissionPolicyHttp,
        WAFv2.PutPermissionPolicyHttp,
        WAFv2.DeletePermissionPolicyHttp,
        WAFv2.CheckCapacityHttp,
        WAFv2.CreateAPIKeyHttp,
        WAFv2.GetDecryptedAPIKeyHttp,
        WAFv2.ListAPIKeysHttp,
        WAFv2.DeleteAPIKeyHttp,
        WAFv2.DescribeManagedRuleGroupHttp,
        WAFv2.ListAvailableManagedRuleGroupsHttp,
        WAFv2.ListAvailableManagedRuleGroupVersionsHttp,
        WAFv2.DescribeAllManagedProductsHttp,
        WAFv2.DescribeManagedProductsByVendorHttp,
        WAFv2.GetWebACLForResourceHttp,
      ),
    ),
  ),
);
