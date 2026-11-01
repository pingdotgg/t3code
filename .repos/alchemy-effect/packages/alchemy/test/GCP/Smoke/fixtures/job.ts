import * as GCP from "@/GCP";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Store } from "./serverless-resources.ts";

/**
 * Effect-native Cloud Run Job the API triggers through `GCP.Run.RunJob`.
 * Each execution records `executions/{CLOUD_RUN_EXECUTION}` in Firestore.
 */
export default class SmokeJob extends GCP.Run.Job<SmokeJob>()(
  "SmokeJob",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const store = yield* GCP.Firestore.WriteDatabase(Store);
    return {
      run: Effect.gen(function* () {
        const execution = yield* Config.String("CLOUD_RUN_EXECUTION");
        yield* store.set(`executions/${execution}`, {
          execution,
          ranAt: new Date(),
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GCP.Firestore.WriteDatabaseHttp)),
) {}
