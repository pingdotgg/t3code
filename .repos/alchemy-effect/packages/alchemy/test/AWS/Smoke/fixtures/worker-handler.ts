import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  ServerlessResources,
  ServerlessResourcesLive,
} from "./serverless-resources.ts";

/**
 * Worker Lambda: consumes the jobs queue through the SQS event source and
 * forwards each record body (prefixed) into the results queue so the test
 * can observe delivery out-of-band.
 */
export class SmokeWorkerFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "SmokeWorkerFunction",
) {}

export const SmokeWorkerFunctionLive = SmokeWorkerFunction.make(
  {
    main: import.meta.url,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { jobsQueue, resultsQueue } = yield* ServerlessResources;
    const sink = yield* AWS.SQS.QueueSink(resultsQueue);

    yield* AWS.SQS.consumeQueueMessages(
      jobsQueue,
      { batchSize: 10 },
      (records) =>
        records.pipe(
          Stream.map((record) => ({ MessageBody: `processed:${record.body}` })),
          Stream.run(sink),
          Effect.orDie,
        ),
    );
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(AWS.Lambda.QueueEventSource, AWS.SQS.QueueSinkHttp),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp, ServerlessResourcesLive),
      ),
    ),
  ),
).pipe(Layer.provideMerge(ServerlessResourcesLive));

export default SmokeWorkerFunctionLive;
