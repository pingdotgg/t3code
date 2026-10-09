import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { createHash } from "node:crypto";
import {
  Jobs,
  Results,
  resultPath,
  type JobMessage,
  type JobResult,
} from "./resources.ts";

const decode = (data: string | undefined) =>
  Effect.try(
    () =>
      JSON.parse(
        Buffer.from(data ?? "", "base64").toString("utf8"),
      ) as JobMessage,
  );

/** The "work": hash and count the payload. */
const runJob = (job: JobMessage) =>
  Effect.sync((): JobResult => ({
    status: "done",
    sha256: createHash("sha256").update(job.payload, "utf8").digest("hex"),
    words: job.payload.split(/\s+/).filter(Boolean).length,
    chars: job.payload.length,
    submittedAt: job.submittedAt,
    completedAt: new Date().toISOString(),
  }));

/**
 * The consumer. A Cloud Run worker pool has no inbound URL — it runs a
 * long-lived container that pulls from Pub/Sub, which suits queue workers
 * that should keep running regardless of HTTP traffic.
 *
 * `GCP.Run.TopicPullEventSource` creates the pull subscription, pulls
 * batches in the background, and acks a batch only after the handler
 * succeeds. Writing the result with `set` makes processing idempotent: a
 * redelivered job overwrites its document with the same values.
 */
export default class Worker extends GCP.Run.WorkerPool<Worker>()(
  "Worker",
  {
    main: import.meta.url,
    scaling: { manualInstanceCount: 1 },
  },
  Effect.gen(function* () {
    const results = yield* GCP.Firestore.WriteDatabase(Results);

    yield* GCP.PubSub.consumeTopicMessages(
      Jobs,
      { maxMessages: 10, ackDeadlineSeconds: 60 },
      (messages) =>
        messages.pipe(
          Stream.runForEach(({ message }) =>
            Effect.gen(function* () {
              const decoded = yield* Effect.result(decode(message.data));
              // A message that can never parse would be redelivered
              // forever; drop it (the batch ack removes it) instead.
              if (Result.isFailure(decoded)) {
                yield* Effect.logWarning(
                  `dropping malformed message ${message.messageId}`,
                );
                return;
              }
              const job = decoded.success;
              const result = yield* runJob(job);
              yield* results.set(resultPath(job.id), { ...result });
              yield* Effect.log(`job ${job.id}: ${result.words} word(s)`);
            }),
          ),
          // A failure dies the batch, leaving it unacked so Pub/Sub
          // redelivers it after the ack deadline.
          Effect.orDie,
        ),
    );
  }).pipe(
    Effect.provide([
      GCP.Run.TopicPullEventSource,
      GCP.Firestore.WriteDatabaseHttp,
    ]),
  ),
) {}
