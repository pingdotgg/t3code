import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import SqlD1Worker from "./d1-worker.ts";

/**
 * D1 database + Worker for the `SQL.D1` client suite. Kept in its own file
 * so it can also be driven directly, e.g.
 * `alchemy tail --stage test ./test/SQL/fixtures/d1-stack.ts`.
 */
export default Alchemy.Stack(
  "SqlD1Stack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* SqlD1Worker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
