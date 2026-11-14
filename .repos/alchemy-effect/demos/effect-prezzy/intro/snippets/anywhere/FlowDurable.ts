import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { Files, FilesS3 } from "./Files.ts";
import { summarize } from "./Summarize.ts";

// #region show
export default class Digest extends AWS.Lambda.DurableFunction<Digest>()(
  "Digest",
  { main: import.meta.url },
  Effect.gen(function* () {
    const files = yield* Files;

    return Effect.fn(function* (input: { room: string }) {
      const summary = yield* AWS.Lambda.Durable.step("summarize", summarize(input.room));
      yield* AWS.Lambda.Durable.sleep("wait", "1 day");
      yield* AWS.Lambda.Durable.step("save", files.upload(`${input.room}.txt`, summary));
    });
  }).pipe(Effect.provide(FilesS3)),
) {}
// #endregion show
