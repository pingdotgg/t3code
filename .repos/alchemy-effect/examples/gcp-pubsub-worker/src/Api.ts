import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Jobs, Results, resultPath, type JobMessage } from "./resources.ts";

/**
 * The public front of the job queue.
 *
 * - `POST /jobs` — enqueue `{ payload }` and return `202 { id }`.
 * - `GET /jobs/:id` — `200` with the result once the worker is done,
 *   `202 { status: "pending" }` until then.
 *
 * The API never processes a job itself, so a slow or crashed worker only
 * delays results; submissions keep succeeding.
 */
export default class Api extends GCP.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const jobs = yield* GCP.PubSub.WriteTopic(Jobs);
    const results = yield* GCP.Firestore.ReadDatabase(Results);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (
          request.method === "POST" &&
          segments.length === 1 &&
          segments[0] === "jobs"
        ) {
          const body = (yield* request.json.pipe(
            Effect.orElseSucceed(() => ({})),
          )) as { payload?: unknown };
          if (typeof body.payload !== "string") {
            return yield* HttpServerResponse.json(
              { error: "payload must be a string" },
              { status: 400 },
            );
          }

          const job: JobMessage = {
            id: crypto.randomUUID(),
            payload: body.payload,
            submittedAt: new Date().toISOString(),
          };
          yield* jobs
            .publish({
              data: JSON.stringify(job),
              // Attributes are readable without decoding the body, e.g. by
              // a subscription filter.
              attributes: { jobId: job.id },
            })
            .pipe(Effect.orDie);

          return yield* HttpServerResponse.json(
            { id: job.id, status: "pending" },
            { status: 202 },
          );
        }

        if (
          request.method === "GET" &&
          segments.length === 2 &&
          segments[0] === "jobs"
        ) {
          const id = segments[1]!;
          const result = yield* results.get(resultPath(id)).pipe(Effect.orDie);
          // No document yet means the job is queued or in flight. The API
          // keeps no record of submissions, so an unknown id also reads
          // as pending.
          if (result === undefined) {
            return yield* HttpServerResponse.json(
              { id, status: "pending" },
              { status: 202 },
            );
          }
          return yield* HttpServerResponse.json({ id, ...result.fields });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([GCP.PubSub.WriteTopicHttp, GCP.Firestore.ReadDatabaseHttp]),
  ),
) {}
