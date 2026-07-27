import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { EntriesTable, GuestbookCluster, GuestbookNamespace } from "./infra.ts";

const seedEntries = [
  { id: "ada", message: "First computers, now clusters." },
  { id: "grace", message: "A cluster in port is safe, but that is not what clusters are for." },
  { id: "linus", message: "Talk is cheap. Show me the manifest." },
];

/**
 * A one-shot `AWS.EKS.Job` in the INLINE EFFECT form: props + an init Effect
 * whose impl returns `{ run }` — a one-shot entry that executes to
 * completion inside the pod, after which the process exits (the Kubernetes
 * analog of `AWS.ECS.Task`).
 *
 * The Effect program is bundled into a generated image
 * (`main: import.meta.url` names this module as the entrypoint). The
 * `AWS.DynamoDB.PutItem` binding injects the table's name into the pod and
 * grants `dynamodb:PutItem` on the generated pod-identity role.
 *
 * Applying the batch/v1 Job runs it: the seed executes once on deploy.
 * Adding `schedule: "0 3 * * *"` to the props would synthesize a CronJob
 * instead.
 */
export default AWS.EKS.Job(
  "SeedJob",
  // Props are themselves an Effect so they can reference shared resources.
  Effect.gen(function* () {
    const cluster = yield* GuestbookCluster;
    const ns = yield* GuestbookNamespace;
    return {
      cluster,
      main: import.meta.url,
      // Deploy after the namespace exists (see src/infra.ts).
      namespace: ns.name,
      backoffLimit: 2,
    };
  }),
  Effect.gen(function* () {
    const table = yield* EntriesTable;
    const putItem = yield* AWS.DynamoDB.PutItem(table);

    return {
      // One-shot entry: seed the table, log, exit 0.
      run: Effect.gen(function* () {
        yield* Effect.forEach(
          seedEntries,
          (entry) =>
            putItem({
              Item: {
                pk: { S: `entry#${entry.id}` },
                author: { S: entry.id },
                message: { S: entry.message },
              },
            }),
          { discard: true },
        );
        yield* Effect.log(`seeded ${seedEntries.length} guestbook entries`);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.DynamoDB.PutItemHttp)),
);
