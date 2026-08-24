import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DevBox } from "./DevBox.ts";
import { ReleaseBlogger } from "./ReleaseBlogger.ts";
import { EvalLive } from "./tools/Eval.ts";
import { WriteFileDevBox } from "./tools/Fs.ts";
import { GrepLive } from "./tools/Grep.ts";
import { SqlDurableObjectLive } from "./tools/Sql.ts";

export class ReleaseVersion extends Cloudflare.DurableObject<ReleaseVersion>()(
  "ReleaseBlogger",
  Effect.gen(function* () {
    const blogger = yield* ReleaseBlogger;

    return Effect.gen(function* () {
      return {
        generateBlog: Effect.fn(function* (request: { input: any }) {
          yield* blogger.send(request);
        }),
      };
    });
  }).pipe(
    Effect.provide(
      SqlDurableObjectLive.pipe(
        Layer.provideMerge(WriteFileDevBox),
        Layer.provideMerge(GrepLive),
        Layer.provideMerge(EvalLive),
        Layer.provideMerge(Cloudflare.AI.layerChatDurableObject),
        Layer.provideMerge(
          Cloudflare.Containers.layer(DevBox, {
            enableInternet: true,
          }),
        ),
      ),
    ),
  ),
) {}
