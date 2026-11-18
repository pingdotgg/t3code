import * as Axiom from "@alchemy.run/axiom";
import { Observability } from "./observability.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Admission from "./Admission.ts";
import * as Cache from "./Cache.ts";
import * as Cleanup from "./Cleanup.ts";
import * as NativeClients from "./NativeClients.ts";
import * as Savings from "./Savings.ts";
import type { ProtocolBindings } from "./protocolTypes.ts";
import * as Resources from "./resources.ts";

export class Worker extends Cloudflare.Worker<Worker, {}>()("Cache") {}

export const layer = Worker.make(
  Resources.cacheName.pipe(
    Effect.map((name) => ({
      name,
      main: import.meta.filename,
      compatibility: { date: "2026-09-11", flags: ["nodejs_compat"] },
    })),
  ),
  Effect.gen(function* () {
    const savings = yield* Cloudflare.D1.QueryDatabase(yield* Resources.Savings);
    const database = yield* Cloudflare.D1.QueryDatabase(yield* Resources.Index);
    const artifacts = yield* Cloudflare.R2.ReadWriteBucket(yield* Resources.Artifacts);
    const nativeClients = yield* Cloudflare.R2.ReadWriteBucket(yield* Resources.NativeClients);
    const developerKeys = yield* Config.Redacted("DEVELOPER_KEYS");
    const readerKeys = yield* Config.Redacted("READER_KEYS");
    const reads = yield* Cloudflare.RateLimit("READ_LIMITER", {
      namespaceId: "1001",
      simple: { limit: 600, period: 60 },
    });
    const writes = yield* Cloudflare.RateLimit("STORE_LIMITER", {
      namespaceId: "1002",
      simple: { limit: 600, period: 60 },
    });
    const bindings = Effect.gen(function* () {
      return Cache.Bindings.of({
        INDEX: yield* database.raw,
        ARTIFACTS: (yield* artifacts.raw) as unknown as ProtocolBindings["ARTIFACTS"],
        GC_BATCH_SIZE: String(Cleanup.batchSize),
        developerKeys: Redacted.value(developerKeys),
        readerKeys: Redacted.value(readerKeys),
        readLimit: yield* reads.raw,
        storeLimit: yield* writes.raw,
      });
    });
    const nativeRuntime = NativeClients.layer.pipe(
      Layer.provide(
        Layer.effect(
          NativeClients.Bindings,
          Effect.gen(function* () {
            return NativeClients.Bindings.of({
              CLIENTS: yield* nativeClients.raw,
              developerKeys: Redacted.value(developerKeys),
              readerKeys: Redacted.value(readerKeys),
              readLimit: yield* reads.raw,
              storeLimit: yield* writes.raw,
            });
          }),
        ),
      ),
    );
    const admission = yield* Admission.Admission.pipe(Effect.provide(Admission.layer));
    const savingsLayer = Savings.layer.pipe(
      Layer.provide(Layer.effect(Savings.Database, savings.raw)),
    );
    const runtime = Cache.layer.pipe(
      Layer.provide([
        Layer.succeed(Admission.Admission, admission),
        Layer.effect(Cache.Bindings, bindings),
        savingsLayer,
      ]),
    );
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      Cleanup.run().pipe(Effect.provide(runtime), Effect.orDie),
    );
    yield* Cloudflare.Workers.cron("0 * * * *", () =>
      Savings.Savings.pipe(
        Effect.flatMap((savings) => savings.cleanup.pipe(Effect.andThen(savings.emitTotals()))),
        Effect.provide(savingsLayer),
        Effect.orDie,
      ),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Workers.Request;
        if (new URL(request.url).pathname.startsWith(NativeClients.routePrefix)) {
          const native = yield* NativeClients.NativeClients.pipe(Effect.provide(nativeRuntime));
          return HttpServerResponse.fromWeb(yield* native.handle(request));
        }
        const context = yield* Cloudflare.Workers.WorkerExecutionContext;
        const cache = yield* Cache.Cache;
        return HttpServerResponse.fromWeb(yield* cache.handle(request, context.raw));
      }).pipe(Effect.provide(runtime)),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.Workers.RateLimitBinding,
      Cloudflare.Workers.CronEventSourceLive,
      Layer.unwrap(
        Effect.map(Observability, ({ traces, token }) =>
          Axiom.Telemetry({ serviceName: "t3-task-cache", traces, token }),
        ),
      ),
    ]),
  ),
);
// Alchemy's generated Worker entry imports the runtime layer as the default export.
export default layer;
