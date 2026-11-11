// Written the way an agent with only the skill would write it.
// @effect-diagnostics globalDateInEffect:off globalJsonInEffect:off
export default ({
  workflow,
  agent,
  stop,
  webhook,
  WebhookRequest,
  Effect,
}: typeof import("../../../apps/server/src/workflows/api.ts")) => [
  workflow(
    "deploy-watch",
    {
      version: 1,
      payload: WebhookRequest,
      triggers: [webhook("deploys", { key: (request) => request.headers["x-delivery-id"] })],
    },
    Effect.fn(function* (request) {
      const event = JSON.parse(request.body);
      if (event.status !== "failed") return yield* stop("the deploy did not fail");
      yield* agent("investigate", {
        project: "proj-1",
        brief: `The deploy of ${event.service} failed. Find out why and report the cause.`,
      });
    }),
  ),
];
