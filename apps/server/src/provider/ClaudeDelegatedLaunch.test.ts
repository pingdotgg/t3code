import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { claudeRefusalScope, verifyClaudeLaunchBinding } from "./ClaudeDelegatedLaunch.ts";

const fingerprint = JSON.stringify(["direct@example.com", "org", "max", "oauth"]);
const domains = ["claudeAgent:account:direct@example.com", `claudeAgent:credential:${fingerprint}`];
function query(
  options: {
    swap?: boolean;
    organization?: string;
    backend?: string;
    shared?: number;
    sonnet?: number;
  } = {},
) {
  let reads = 0;
  return {
    accountInfo: async () => ({
      apiProvider: options.backend ?? "firstParty",
      organization: options.organization ?? "org",
      subscriptionType: "max",
      tokenSource: "oauth",
      email: options.swap && reads++ > 0 ? "changed@example.com" : "direct@example.com",
    }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: options.shared ?? 0 },
        seven_day: { utilization: 0 },
        model_scoped: [{ display_name: "Sonnet", utilization: options.sonnet ?? 0 }],
      },
    }),
  } as unknown as Query;
}
it.effect(
  "rechecks native Claude's runtime query identity and relevant quota before offering a prompt",
  () =>
    Effect.gen(function* () {
      yield* verifyClaudeLaunchBinding(query(), domains, "claude-sonnet-5-5");
      yield* verifyClaudeLaunchBinding(query({ sonnet: 100 }), domains, "claude-opus-5-5");
      const sonnet = yield* verifyClaudeLaunchBinding(
        query({ sonnet: 100 }),
        domains,
        "claude-sonnet-5-5",
      ).pipe(Effect.flip);
      assert.deepEqual(sonnet.quotaScope, { type: "window", windowId: "seven_day_sonnet" });
      const shared = yield* verifyClaudeLaunchBinding(
        query({ shared: 100 }),
        domains,
        "claude-opus-5-5",
      ).pipe(Effect.flip);
      assert.deepEqual(shared.quotaScope, { type: "account" });
      for (const options of [{ organization: "other-org" }, { backend: "gateway" }]) {
        const denied = yield* verifyClaudeLaunchBinding(
          query(options),
          domains,
          "claude-sonnet-5-5",
        ).pipe(Effect.flip);
        assert.equal(denied.code, "delegated_capacity_unverified");
      }
      const swapped = yield* verifyClaudeLaunchBinding(
        query({ swap: true }),
        domains,
        "claude-sonnet-5-5",
      ).pipe(Effect.flip);
      assert.equal(swapped.code, "delegated_capacity_unverified");
    }),
);
it("defaults unknown, mixed and shared Claude refusal scopes to the account", () => {
  for (const types of [
    [],
    ["unknown"],
    ["five_hour"],
    ["seven_day"],
    ["seven_day_sonnet", "seven_day_opus"],
  ])
    assert.deepEqual(claudeRefusalScope(types), { type: "account" });
  assert.deepEqual(claudeRefusalScope(["seven_day_sonnet"]), {
    type: "window",
    windowId: "seven_day_sonnet",
  });
});
