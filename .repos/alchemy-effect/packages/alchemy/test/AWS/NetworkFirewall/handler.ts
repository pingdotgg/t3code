import * as Lambda from "@/AWS/Lambda";
import * as NetworkFirewall from "@/AWS/NetworkFirewall";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class NetworkFirewallBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "NetworkFirewallBindingsFunction",
) {}

export default NetworkFirewallBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    // A policy and a stateful rule group are cheap (seconds to provision)
    // and exercise the policy- and rule-group-scoped grants + ARN injection.
    const ruleGroup = yield* NetworkFirewall.RuleGroup("BindingsRuleGroup", {
      type: "STATEFUL",
      capacity: 10,
      rules:
        'pass tcp any any -> any 443 (msg:"allow https"; sid:100001; rev:1;)',
      summaryConfiguration: { RuleOptions: ["SID", "MSG"] },
    });
    const policy = yield* NetworkFirewall.FirewallPolicy("BindingsPolicy", {
      firewallPolicy: {
        StatelessDefaultActions: ["aws:forward_to_sfe"],
        StatelessFragmentDefaultActions: ["aws:forward_to_sfe"],
        StatefulRuleGroupReferences: [{ ResourceArn: ruleGroup.ruleGroupArn }],
      },
    });

    const bound = {
      describeFirewallPolicy:
        yield* NetworkFirewall.DescribeFirewallPolicy(policy),
      describeRuleGroup: yield* NetworkFirewall.DescribeRuleGroup(ruleGroup),
      describeRuleGroupSummary:
        yield* NetworkFirewall.DescribeRuleGroupSummary(ruleGroup),
      describeRuleGroupMetadata:
        yield* NetworkFirewall.DescribeRuleGroupMetadata(ruleGroup),
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

        // Policy-scoped describe — the policy ARN is injected.
        if (request.method === "GET" && pathname === "/policy") {
          const response = yield* bound.describeFirewallPolicy();
          return yield* HttpServerResponse.json({
            status: response.FirewallPolicyResponse.FirewallPolicyStatus,
            statelessDefaultActions:
              response.FirewallPolicy?.StatelessDefaultActions ?? [],
          });
        }

        // Rule-group-scoped describe — the rule group ARN is injected.
        if (request.method === "GET" && pathname === "/rule-group") {
          const response = yield* bound.describeRuleGroup();
          return yield* HttpServerResponse.json({
            status: response.RuleGroupResponse.RuleGroupStatus,
            type: response.RuleGroupResponse.Type,
            rulesString: response.RuleGroup?.RulesSource?.RulesString ?? "",
          });
        }

        if (request.method === "GET" && pathname === "/rule-group/summary") {
          const response = yield* bound.describeRuleGroupSummary();
          return yield* HttpServerResponse.json({
            ruleCount: (response.Summary?.RuleSummaries ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/rule-group/metadata") {
          const response = yield* bound.describeRuleGroupMetadata();
          return yield* HttpServerResponse.json({
            capacity: response.Capacity ?? 0,
            type: response.Type ?? "",
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
        NetworkFirewall.DescribeFirewallPolicyHttp,
        NetworkFirewall.DescribeRuleGroupHttp,
        NetworkFirewall.DescribeRuleGroupSummaryHttp,
        NetworkFirewall.DescribeRuleGroupMetadataHttp,
      ),
    ),
  ),
);
