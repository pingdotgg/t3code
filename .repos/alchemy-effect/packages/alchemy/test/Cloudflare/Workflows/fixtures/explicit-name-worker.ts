import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const EXPLICIT_WORKFLOW_NAME = "alchemy-pr1460-effect-workflow";

export class ExplicitNameWorkflow extends Cloudflare.Workflow<ExplicitNameWorkflow>()(
  "ExplicitNameWorkflow",
  { workflowName: EXPLICIT_WORKFLOW_NAME, schedules: ["0 0 1 1 *"] },
  Effect.succeed(
    Effect.fn(function* () {
      const event = yield* Cloudflare.Workflows.WorkflowEvent;
      return yield* Cloudflare.Workflows.task(
        "greet",
        Effect.succeed({
          greeting: "Hello, world!",
          workflowName: event.workflowName,
          instanceId: event.instanceId,
        }),
      );
    }),
  ),
) {}

export default class ExplicitNameWorkflowWorker extends Cloudflare.Worker<ExplicitNameWorkflowWorker>()(
  "ExplicitNameWorkflowWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workflow = yield* ExplicitNameWorkflow;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/workflow/start/")) {
          const instance = yield* workflow.create();
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
