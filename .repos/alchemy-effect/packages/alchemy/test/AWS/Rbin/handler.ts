import * as Lambda from "@/AWS/Lambda";
import * as Rbin from "@/AWS/Rbin";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class RbinTestFunction extends Lambda.Function<Lambda.Function>()(
  "RbinTestFunction",
) {}

export default RbinTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The retention rule the rule-scoped binding is bound to. Tag-level and
    // targeting a tag no snapshot carries, so it never retains anything.
    const rule = yield* Rbin.Rule("BindingRule", {
      resourceType: "EBS_SNAPSHOT",
      retentionPeriod: "7 days",
      description: "alchemy rbin bindings fixture rule",
      resourceTags: [{ key: "AlchemyRbinBindings", value: "true" }],
    });

    const getRule = yield* Rbin.GetRule(rule);
    const listRules = yield* Rbin.ListRules();

    const bound = { getRule, listRules };

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

        // Rule-scoped read: the Identifier is injected from the binding.
        if (request.method === "GET" && pathname === "/rule") {
          const detail = yield* getRule();
          return yield* HttpServerResponse.json({
            identifier: detail.Identifier,
            resourceType: detail.ResourceType,
            retentionDays: detail.RetentionPeriod?.RetentionPeriodValue,
            description: detail.Description,
          });
        }

        // Account-level list, scoped to the fixture rule's resource type.
        if (request.method === "GET" && pathname === "/rules") {
          const { Rules } = yield* listRules({
            ResourceType: "EBS_SNAPSHOT",
          });
          return yield* HttpServerResponse.json({
            ids: (Rules ?? []).map((summary) => summary.Identifier),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Rbin.GetRuleHttp, Rbin.ListRulesHttp))),
);
