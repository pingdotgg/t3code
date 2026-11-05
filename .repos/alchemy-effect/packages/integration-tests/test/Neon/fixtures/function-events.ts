import { Bucket } from "@alchemy.run/neon/Bucket";
import { BucketEventSource } from "@alchemy.run/neon/BucketEventSource";
import { BucketEventSourceHttp } from "@alchemy.run/neon/BucketEventSourceHttp";
import { CronEventSource } from "@alchemy.run/neon/CronEventSource";
import { CronEventSourceHttp } from "@alchemy.run/neon/CronEventSourceHttp";
import { Function } from "@alchemy.run/neon/Function";
import { Project } from "@alchemy.run/neon/Project";
import { WriteBucket } from "@alchemy.run/neon/WriteBucket";
import { WriteBucketHttp } from "@alchemy.run/neon/WriteBucketHttp";
import { Postgres } from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const project = Project("EventProject", { region: "aws-us-east-2" });
export const bucket = Bucket(
  "EventBucket",
  Effect.gen(function* () {
    return { project: yield* project, forceDestroy: true };
  }),
);

export default class EventFunction extends Function<EventFunction>()(
  "EventFunction",
  Effect.gen(function* () {
    return { project: yield* project, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const uploads = yield* bucket;
    const files = yield* WriteBucket(uploads);
    const sql = yield* Postgres({
      url: Effect.sync(() => Redacted.make(process.env.DATABASE_URL!)),
    });
    const prepare = sql`CREATE TABLE IF NOT EXISTS alchemy_function_events (id text PRIMARY KEY, kind text NOT NULL, object_key text)`;
    yield* CronEventSource("Minute", { cron: "* * * * *" }, (event) =>
      prepare.pipe(
        Effect.andThen(
          sql`INSERT INTO alchemy_function_events (id, kind) VALUES (${event.invocationId}, 'schedule') ON CONFLICT DO NOTHING`,
        ),
        Effect.asVoid,
      ),
    );
    yield* BucketEventSource(uploads, { name: "Uploads", prefix: "incoming/" }, (event) =>
      prepare.pipe(
        Effect.andThen(
          sql`INSERT INTO alchemy_function_events (id, kind, object_key) VALUES (${event.invocationId}, 'upload', ${event.objectKey}) ON CONFLICT DO NOTHING`,
        ),
        Effect.asVoid,
      ),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "https://function.test").pathname;
        yield* prepare.pipe(Effect.orDie);
        if (path === "/upload") {
          yield* files.put("incoming/test.txt", "uploaded").pipe(Effect.orDie);
          yield* files.put("outside.txt", "not-matched").pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }
        const events =
          yield* sql`SELECT id, kind, object_key FROM alchemy_function_events ORDER BY id`.pipe(
            Effect.orDie,
          );
        return yield* HttpServerResponse.json(events);
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(WriteBucketHttp, CronEventSourceHttp, BucketEventSourceHttp)),
  ),
) {}
