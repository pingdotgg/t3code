import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Tagged Worker DX: declare the class first (lightweight identifier),
// then provide the runtime implementation in a second `.make()` call.
// This mirrors the pattern in the README/docstring on Cloudflare.Worker.
export class WorkerTag extends Cloudflare.Worker<WorkerTag>()("WorkerTag", {
  main: import.meta.filename,
  compatibility: {
    flags: ["nodejs_compat"],
    date: "2026-04-26",
  },
  observability: {
    enabled: true,
  },
}) {}

export default WorkerTag.make(
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello from WorkerTag", {
          status: 200,
        });
      }),
    };
  }),
);
