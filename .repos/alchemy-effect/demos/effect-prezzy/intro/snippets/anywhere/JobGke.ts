import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Effect from "effect/Effect";
import { Files, FilesGCS } from "./Files.ts";
import { Gke } from "./Gke.ts";

// #region show
export default Kubernetes.Job(
  "Report",
  Effect.gen(function* () {
    return { main: import.meta.url, cluster: yield* Gke };
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
