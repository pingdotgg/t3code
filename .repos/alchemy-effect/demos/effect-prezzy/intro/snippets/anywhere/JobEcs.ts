import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { Files, FilesS3 } from "./Files.ts";

// #region show
export default AWS.ECS.Task(
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
  }).pipe(Effect.provide(FilesS3)),
);
// #endregion show
