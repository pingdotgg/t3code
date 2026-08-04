import * as Cloudflare from "@/Cloudflare";
import * as Drizzle from "@/Drizzle";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import D1DrizzleWorker from "./drizzle-worker.ts";

/**
 * Schema → migrations → D1 → Worker, all in one stack. Kept in its own file
 * so it can also be driven directly, e.g.
 * `alchemy tail --stage test ./test/Cloudflare/D1/fixtures/drizzle-stack.ts`.
 */
export default Alchemy.Stack(
  "D1DrizzleStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* D1DrizzleWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
