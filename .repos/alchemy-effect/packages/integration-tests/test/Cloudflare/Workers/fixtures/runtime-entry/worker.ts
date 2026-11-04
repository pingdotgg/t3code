import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class RuntimeEntryWorker extends Worker<RuntimeEntryWorker>()(
  "RuntimeEntryWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Init also runs inside the deployed Worker, so the bridge must provide `Stage`.
    const stage = yield* Stage;
    return {
      fetch: Effect.succeed(HttpServerResponse.text(`runtime-entry:${stage}`)),
    };
  }),
) {}
