import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Files, FilesR2 } from "./Files.ts";
import { summarize } from "./Summarize.ts";

// #region show
export default class Digest extends Cloudflare.Workflow<Digest>()(
  "Digest",
  Effect.gen(function* () {
    const files = yield* Files;

    return Effect.fn(function* (input: { room: string }) {
      const summary = yield* Cloudflare.Workflows.task("summarize", summarize(input.room));
      yield* Cloudflare.Workflows.sleep("wait", "1 day");
      yield* Cloudflare.Workflows.task("save", files.upload(`${input.room}.txt`, summary));
    });
  }).pipe(Effect.provide(FilesR2)),
) {}
// #endregion show
