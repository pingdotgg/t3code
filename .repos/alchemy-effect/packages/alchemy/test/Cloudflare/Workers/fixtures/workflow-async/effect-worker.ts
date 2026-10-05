import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const COLD_EFFECT_WORKFLOW_NAME = "alchemy-pr1460-cold-effect-adoption";

class ColdAdoptedWorkflow extends Cloudflare.Workflow<ColdAdoptedWorkflow>()(
  "ColdAdoptedWorkflow",
  { workflowName: COLD_EFFECT_WORKFLOW_NAME },
  Effect.succeed(
    Effect.fn(function* (input: { value: string }) {
      const event = yield* Cloudflare.Workflows.WorkflowEvent;
      return yield* Cloudflare.Workflows.task(
        "greet",
        Effect.succeed({
          greeting: `Hello, ${input.value}!`,
          workflowName: event.workflowName,
        }),
      );
    }),
  ),
) {}

export default class ColdEffectWorker extends Cloudflare.Worker<ColdEffectWorker>()(
  "ColdEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workflow = yield* ColdAdoptedWorkflow;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/workflow/start/")) {
          const instance = yield* workflow.create({
            params: { value: "world" },
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }
        if (request.url.startsWith("/workflow/status/")) {
          const instance = yield* workflow.get(request.url.split("/").pop()!);
          return yield* HttpServerResponse.json(yield* instance.status());
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
