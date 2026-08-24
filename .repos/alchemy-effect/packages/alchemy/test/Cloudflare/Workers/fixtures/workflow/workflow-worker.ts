import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import TestWorkflow from "./test-workflow.ts";

export default class WorkflowTestWorker extends Cloudflare.Worker<WorkflowTestWorker>()(
  "WorkflowTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const workflow = yield* TestWorkflow;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/workflow/start/")) {
          const value = request.url.split("/workflow/start/")[1] ?? "world";
          const instance = yield* workflow.create({ params: { value } });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        if (request.url.startsWith("/workflow/wait/")) {
          const value = request.url.split("/workflow/wait/")[1] ?? "world";
          const instance = yield* workflow.create({
            params: { value, wait: true },
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        if (request.url.startsWith("/workflow/send/")) {
          const [, rest = ""] = request.url.split("/workflow/send/");
          const [instanceId = "", message = "received"] = rest.split("/");
          const instance = yield* workflow.get(instanceId);
          yield* instance.sendEvent({
            type: "test-event",
            payload: { message },
          });
          return yield* HttpServerResponse.json({ ok: true });
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
