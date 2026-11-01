import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Summarize from "./Summarize.ts";

/**
 * An admin endpoint for running the nightly batch on demand — after a
 * backfill, say, instead of waiting for the schedule.
 *
 * - `POST /run` — start a {@link Summarize} execution and return its
 *   operation name. Cloud Run Jobs are asynchronous: this answers as soon
 *   as the execution is created, not when it finishes.
 *
 * The service is public so the example can be driven with `curl`. In
 * production, drop `invokerIamDisabled` and call it with an identity
 * token instead.
 */
export default class Admin extends GCP.Function<Admin>()(
  "Admin",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    // Grants this service's runtime account permission to run the job.
    const runSummarize = yield* GCP.Run.RunJob(Summarize);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && url.pathname === "/run") {
          const operation = yield* runSummarize().pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            { operation: operation.name ?? null },
            { status: 202 },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide(GCP.Run.RunJobHttp)),
) {}
