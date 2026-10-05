import * as GCP from "alchemy/GCP";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import {
  EntriesDatabase,
  entryPath,
  GuestbookCluster,
  GuestbookNamespace,
} from "./infra.ts";

export const seedEntries = [
  { id: "ada", message: "First computers, now clusters." },
  {
    id: "grace",
    message:
      "A cluster in port is safe, but that is not what clusters are for.",
  },
  { id: "linus", message: "Talk is cheap. Show me the manifest." },
];

/**
 * A one-shot `Kubernetes.Job` in the INLINE EFFECT form: props + an init Effect
 * whose impl returns `{ run }` — a one-shot entry that executes to
 * completion inside the pod, after which the process exits (the Kubernetes
 * analog of `GCP.Run.Job`).
 *
 * The Effect program is bundled into a generated image
 * (`main: import.meta.url` names this module as the entrypoint). The
 * `GCP.Firestore.WriteDatabase` binding injects the database name into the
 * pod and grants `roles/datastore.user` (project-level, conditioned to the
 * database) to the Job's Kubernetes ServiceAccount principal.
 *
 * Applying the batch/v1 Job runs it: the seed executes once on deploy.
 * Adding `schedule: "0 3 * * *"` to the props would synthesize a CronJob
 * instead.
 */
export default Kubernetes.Job(
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
      // A fresh deploy's Firestore grant (a project binding under an IAM
      // Condition) can take a few minutes to reach Firestore; Kubernetes
      // retries the pod with exponential backoff (10s, 20s, 40s, …) until
      // then.
      backoffLimit: 6,
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "250m", memory: "512Mi" },
      },
    };
  }),
  Effect.gen(function* () {
    const db = yield* GCP.Firestore.WriteDatabase(EntriesDatabase);

    return {
      // One-shot entry: seed the database, log, exit 0.
      run: Effect.gen(function* () {
        yield* Effect.forEach(
          seedEntries,
          (entry) =>
            db.set(entryPath(entry.id), {
              author: entry.id,
              message: entry.message,
            }),
          { discard: true },
        );
        yield* Effect.log(`seeded ${seedEntries.length} guestbook entries`);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GCP.Firestore.WriteDatabaseHttp)),
);
