import * as DLM from "@/AWS/DLM";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class DlmTestFunction extends Lambda.Function<Lambda.Function>()(
  "DlmTestFunction",
) {}

export default DlmTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The lifecycle policy the policy-scoped binding is bound to. DISABLED
    // and targeting a tag no volume carries, so it never creates snapshots.
    const policy = yield* DLM.LifecyclePolicy("BindingPolicy", {
      description: "alchemy dlm bindings fixture policy",
      state: "DISABLED",
      policyDetails: {
        resourceTypes: ["VOLUME"],
        targetTags: { AlchemyDlmBindings: "true" },
        schedules: [
          {
            name: "Daily",
            createRule: { interval: 24, intervalUnit: "HOURS" },
            retainRule: { count: 1 },
          },
        ],
      },
    });

    // Event source: subscribe the host to DLM policy state-change events.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* DLM.consumePolicyEvents({ kinds: ["state-change"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `dlm state change: ${event.detail.policy_id} -> ${event.detail.state}`,
        ),
      ),
    );

    const getLifecyclePolicy = yield* DLM.GetLifecyclePolicy(policy);
    const getLifecyclePolicies = yield* DLM.GetLifecyclePolicies();

    const bound = { getLifecyclePolicy, getLifecyclePolicies };

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

        // Policy-scoped read: the PolicyId is injected from the binding.
        if (request.method === "GET" && pathname === "/policy") {
          const { Policy } = yield* getLifecyclePolicy();
          return yield* HttpServerResponse.json({
            policyId: Policy?.PolicyId,
            state: Policy?.State,
            policyType: Policy?.PolicyDetails?.PolicyType,
          });
        }

        // Account-level list, filtered down to the fixture's policy state.
        if (request.method === "GET" && pathname === "/policies") {
          const { Policies } = yield* getLifecyclePolicies({
            State: "DISABLED",
          });
          return yield* HttpServerResponse.json({
            ids: (Policies ?? []).map((summary) => summary.PolicyId),
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
        Lambda.EventSource,
        DLM.GetLifecyclePolicyHttp,
        DLM.GetLifecyclePoliciesHttp,
      ),
    ),
  ),
);
