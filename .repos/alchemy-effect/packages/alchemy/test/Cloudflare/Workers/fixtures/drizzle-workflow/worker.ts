import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Drizzle from "@/Drizzle/index.ts";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "./db.ts";
import { relations, Widgets } from "./schema.ts";
import DrizzleWorkflow from "./workflow.ts";

/**
 * Worker that hosts {@link DrizzleWorkflow} and exposes start/status routes so
 * the test can fire an instance and poll it to completion. The Hyperdrive
 * binding is declared inside the workflow (not here) and propagates onto this
 * worker's deployment config, mirroring how a Durable Object declares its own
 * bindings.
 *
 * The `/query/:id` route runs a Drizzle query directly in the fetch handler —
 * the isolate builds its layers once, and each event builds (and closes) its
 * own pool against its per-event scope. The test hammers it with sequential
 * and concurrent requests to pin the cross-request regression: no
 * "Cannot perform I/O on behalf of a different request", no
 * "Cannot use a pool after calling end on the pool".
 */
export default class DrizzleWorkflowWorker extends Cloudflare.Worker<DrizzleWorkflowWorker>()(
  "DrizzleWorkflowWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const workflow = yield* DrizzleWorkflow;
    // `proxyChain` defers the connect to the first query, so the pool opens
    // inside a fetch event — where the per-event scope is provided — not
    // here at init.
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.Postgres(conn.connectionString, { relations });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/workflow/start/")) {
          const id = Number(request.url.split("/workflow/start/")[1] ?? "1");
          const instance = yield* workflow.create({
            params: { id, name: `widget-${id}` },
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        if (request.url.startsWith("/workflow/status/")) {
          const instanceId = request.url.split("/workflow/status/")[1] ?? "";
          const instance = yield* workflow.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        }

        if (request.url.startsWith("/query/")) {
          const id = Number(request.url.split("/query/")[1] ?? "1");
          const rows = yield* db
            .select()
            .from(Widgets)
            .where(eq(Widgets.id, id))
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ rowCount: rows.length });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
