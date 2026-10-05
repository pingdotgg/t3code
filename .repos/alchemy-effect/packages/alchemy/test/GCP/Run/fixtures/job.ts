import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";

export const MARKER_OBJECT = "marker.txt";

/**
 * Effect-native Cloud Run Job whose `run` entry writes a Storage object.
 * Deployed from {@link ../Job.test.ts}.
 */
export default class MarkerJob extends GCP.Run.Job<MarkerJob>()(
  "MarkerJob",
  {
    main: import.meta.url,
    location: "us-central1",
  },
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.Bucket("JobRunMarker", {
      forceDestroy: true,
    });
    const putObject = yield* GCP.Storage.PutObject(bucket);
    return {
      run: putObject({ name: MARKER_OBJECT, body: "ran" }).pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    };
  }).pipe(Effect.provide(GCP.Storage.PutObjectHttp)),
) {}
