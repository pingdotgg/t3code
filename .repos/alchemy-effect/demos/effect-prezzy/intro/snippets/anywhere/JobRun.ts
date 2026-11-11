import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { Files, FilesGCS } from "./Files.ts";

// #region show
export default GCP.Run.Job(
  "Report",
  Effect.gen(function* () {
    return { main: import.meta.url };
  }),
  Effect.gen(function* () {
    const files = yield* Files;
    return {
      run: Effect.gen(function* () {
        const report = `generated at ${new Date().toISOString()}`;
        yield* files.upload("report.txt", report);
      }),
    };
  }).pipe(Effect.provide(FilesGCS)),
);
// #endregion show
