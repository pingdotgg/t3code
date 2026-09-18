import { Worker } from "@/Cloudflare/Workers/Worker";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class RuntimeEntryWorker extends Worker<RuntimeEntryWorker>()(
  "RuntimeEntryWorker",
  { main: import.meta.url },
  Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("runtime-entry:ok")),
  }),
) {}
