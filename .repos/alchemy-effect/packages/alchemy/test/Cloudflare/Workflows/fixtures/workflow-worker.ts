import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import LocalTestWorkflow, {
  failureScenarios,
  rollbackConfigs,
  RollbackResults,
} from "./test-workflow.ts";

/** Exposes workflow creation, status, and persisted rollback results over HTTP. */
export default class WorkflowLocalWorker extends Cloudflare.Worker<WorkflowLocalWorker>()(
  "WorkflowLocalWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const workflow = yield* LocalTestWorkflow;
    const bucket = yield* RollbackResults;
    const results = yield* Cloudflare.R2.ReadWriteBucket(bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url === "/workflow/probe") {
          const instance = yield* workflow.create({
            params: { value: "", ready: true },
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        if (request.url.startsWith("/workflow/start/")) {
          const value = request.url.split("/workflow/start/")[1] ?? "world";
          const instance = yield* workflow.create({ params: { value } });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        const scenario = failureScenarios.find(
          (name) => request.url === `/workflow/scenario/${name}`,
        );
        if (scenario) {
          const instance = yield* workflow.create({
            params: { value: "reserved", scenario },
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        if (request.url.startsWith("/workflow/record/")) {
          const key = request.url.split("/workflow/record/")[1] ?? "";
          const object = yield* results.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            object ? yield* object.json().pipe(Effect.orDie) : null,
          );
        }

        if (request.url === "/workflow/rollback") {
          const instance = yield* workflow.create({
            params: { value: "reserved", rollback: true },
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        if (request.url.startsWith("/workflow/rollback-result/")) {
          const instanceId = request.url.split("/workflow/rollback-result/")[1];
          const records = yield* Effect.forEach(
            Object.keys(rollbackConfigs),
            (name) =>
              Effect.gen(function* () {
                const object = yield* results.get(`${instanceId}/${name}`);
                return object ? yield* object.json() : null;
              }),
          ).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(records);
        }

        if (request.url.startsWith("/workflow/status/")) {
          const instanceId = request.url.split("/workflow/status/")[1] ?? "";
          const instance = yield* workflow.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        }

        if (request.url.startsWith("/workflow/events/")) {
          const instance = yield* workflow.get(
            request.url.split("/workflow/events/")[1]!,
          );
          const events = yield* instance
            .subscribe({ filter: ["workflow_queued"] })
            .pipe(Stream.take(1), Stream.runCollect);
          return yield* HttpServerResponse.json(events);
        }
        if (request.url.startsWith("/workflow/delete/")) {
          const instance = yield* workflow.get(
            request.url.split("/workflow/delete/")[1]!,
          );
          yield* instance.delete();
          // A second deletion should report the now-missing instance as an error.
          return yield* HttpServerResponse.json(
            yield* workflow.deleteBatch([instance.id]),
          );
        }
        if (request.url.startsWith("/workflow/delete-batch/")) {
          const id = request.url.split("/workflow/delete-batch/")[1]!;
          return yield* HttpServerResponse.json(
            yield* workflow.deleteBatch([id, "missing-instance"]),
          );
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
