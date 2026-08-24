import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import PauseWorkflowWorker from "./fixtures/workflow-pause/worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

interface WorkflowStatus {
  status: string;
  error?: { message?: string } | null;
}

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const isSettledAfterPause = (status: WorkflowStatus) =>
  status.status === "paused" ||
  status.status === "errored" ||
  status.status === "complete" ||
  status.status === "terminated";

/**
 * End-to-end regression for #930: under local `alchemy dev`, pausing during an
 * active `Cloudflare.Workflows.task` must leave the instance `paused` once that
 * task finishes — not `errored` with `UnknownError` from `Effect.tryPromise`.
 */
test.provider(
  "pausing during an active task settles as paused under local workerd",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          const w = yield* PauseWorkflowWorker;
          return { worker: w };
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const url = worker.url!;
      expect(url).toBeTypeOf("string");

      const { instanceId } = yield* client
        .post(`${url}/workflow/start/world`)
        .pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json.pipe(
                  Effect.flatMap((body) => {
                    const instanceId = (body as { instanceId?: unknown })
                      .instanceId;
                    return typeof instanceId === "string"
                      ? Effect.succeed({ instanceId })
                      : Effect.fail(
                          new Error("Worker returned no workflow id"),
                        );
                  }),
                )
              : Effect.fail(new WorkerNotReady({ status: res.status })),
          ),
          Effect.retry({
            while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
            schedule: Schedule.max([
              Schedule.exponential("500 millis"),
              Schedule.recurs(15),
            ]),
          }),
        );

      const pauseRes = yield* client.post(
        `${url}/workflow/pause/${instanceId}`,
      );
      expect(pauseRes.status).toBe(200);

      // The active task sleeps 8s; give the engine time to finish the step and
      // apply the pending pause (or incorrectly mark the run errored).
      const lastStatus = yield* client
        .get(`${url}/workflow/status/${instanceId}`)
        .pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json.pipe(
                  Effect.map((json) => json as unknown as WorkflowStatus),
                )
              : Effect.succeed({ status: "pending" } as WorkflowStatus),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: isSettledAfterPause,
            times: 40,
          }),
        );

      expect(lastStatus.status).toBe("paused");
      expect(lastStatus.error).toBeFalsy();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
