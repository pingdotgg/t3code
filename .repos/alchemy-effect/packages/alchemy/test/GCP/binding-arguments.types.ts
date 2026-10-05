/**
 * Type-level check (compiled with the test project, never run): bindings
 * and event sources accept a resource, the Effect that declares it, or the
 * resolved value from `yield*`.
 */
import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";

const Dataset = GCP.BigQuery.Dataset("D", {});
const Table = Effect.gen(function* () {
  const dataset = yield* Dataset;
  return yield* GCP.BigQuery.Table("T", { datasetId: dataset.datasetId });
});
const Topic = GCP.PubSub.Topic("Tp", {});
const Bucket = GCP.Storage.Bucket("B", {});
const Db = GCP.Firestore.Database("Db", {});
const Secret = GCP.SecretManager.Secret("S", {});
const Sub = GCP.PubSub.Subscription("Sub", { topic: "x" });
const Key = GCP.KMS.CryptoKey("K", { keyRing: "r" });
const Job = GCP.Run.Job("J", { containers: [{ image: "x" }] });

export const program = Effect.gen(function* () {
  yield* GCP.BigQuery.WriteTable(Table);
  yield* GCP.BigQuery.ReadTable(Table);
  yield* GCP.BigQuery.Query(Dataset);
  yield* GCP.PubSub.WriteTopic(Topic);
  yield* GCP.PubSub.Publish(Topic);
  yield* GCP.PubSub.ReadSubscription(Sub);
  yield* GCP.Storage.ReadWriteBucket(Bucket);
  yield* GCP.Storage.PutObject(Bucket);
  yield* GCP.Firestore.ReadWriteDatabase(Db);
  yield* GCP.SecretManager.ReadSecret(Secret);
  yield* GCP.KMS.Encrypt(Key);
  yield* GCP.Run.RunJob(Job);
  yield* GCP.PubSub.consumeTopicMessages(Topic, () => Effect.void);
  yield* GCP.Storage.consumeBucketEvents(Bucket, () => Effect.void);
});

import * as AWS from "@/AWS";
const Queue = AWS.SQS.Queue("Q", {});
export const aws = Effect.gen(function* () {
  yield* AWS.SQS.consumeQueueMessages(Queue, () => Effect.void);
  yield* AWS.SQS.consumeQueueMessages(yield* Queue, () => Effect.void);
  yield* GCP.PubSub.consumeTopicMessages(
    yield* Topic,
    { ackDeadlineSeconds: 30 },
    () => Effect.void,
  );
});
