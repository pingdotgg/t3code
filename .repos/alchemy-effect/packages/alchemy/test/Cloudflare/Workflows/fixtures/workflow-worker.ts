import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import LocalTestWorkflow from "./test-workflow.ts";

/**
 * Fixture worker hosting {@link LocalTestWorkflow} for
 * `Workflow.local.test.ts`. Exposes one route per behavior:
 *
 *  - `POST /workflow/start/:value` — create an instance
 *  - `GET  /workflow/status/:id`   — read instance status
 */
export default class WorkflowLocalWorker extends Cloudflare.Worker<WorkflowLocalWorker>()(
  "WorkflowLocalWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const workflow = yield* LocalTestWorkflow;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/workflow/start/")) {
          const value = request.url.split("/workflow/start/")[1] ?? "world";
          const instance = yield* workflow.create({ params: { value } });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        if (request.url.startsWith("/workflow/status/")) {
          const instanceId = request.url.split("/workflow/status/")[1] ?? "";
          const instance = yield* workflow.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
