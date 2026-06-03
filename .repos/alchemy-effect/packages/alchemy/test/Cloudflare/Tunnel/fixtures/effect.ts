import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture that exercises all three Cloudflare tunnel
 * runtime bindings from a single Worker:
 *
 * - {@link Cloudflare.TunnelRead} — read-only (`/read`)
 * - {@link Cloudflare.TunnelWrite} — mutating (`/write`)
 * - {@link Cloudflare.TunnelReadWrite} — full CRUD (`/readwrite`)
 *
 * Each binding provisions its own least-privilege {@link Cloudflare.AccountApiToken}
 * (binding the token's outputs into the Worker) and the routes below run a
 * self-contained scenario per binding so the test can assert one behavior each.
 */
export default class TunnelEffectWorker extends Cloudflare.Worker<TunnelEffectWorker>()(
  "TunnelEffectWorker",
  {
    main: import.meta.filename,
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const read = yield* Cloudflare.TunnelRead.bind();
    const write = yield* Cloudflare.TunnelWrite.bind();
    const tunnels = yield* Cloudflare.TunnelReadWrite.bind();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const name = url.searchParams.get("name") ?? "alchemy-tunnel";

        // Read-only: prove the read token works by listing tunnels.
        if (url.pathname === "/read") {
          const list = yield* read
            .list({ isDeleted: false })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ count: list.result?.length });
        }

        // Write: create then delete with the write-scoped token.
        if (url.pathname === "/write") {
          const tunnel = yield* write
            .create({ name, configSrc: "cloudflare" })
            .pipe(Effect.orDie);
          yield* write.delete(tunnel.id!).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            id: tunnel.id,
            deleted: true,
          });
        }

        // Read + write: drive the full CRUD surface end to end.
        if (url.pathname === "/readwrite") {
          const created = yield* tunnels
            .create({ name, configSrc: "cloudflare" })
            .pipe(Effect.orDie);
          const id = created.id!;
          const got = yield* tunnels.get(id).pipe(Effect.orDie);
          const list = yield* tunnels.list().pipe(Effect.orDie);
          const updated = yield* tunnels
            .update(id, { name: `${name}-renamed` })
            .pipe(Effect.orDie);
          const token = yield* tunnels.getToken(id).pipe(Effect.orDie);
          yield* tunnels.delete(id).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            id,
            getName: got.name,
            count: list.result?.length,
            updatedName: updated.name,
            hasToken: token.length > 0,
            deleted: true,
          });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.TunnelReadLive,
        Cloudflare.TunnelWriteLive,
        Cloudflare.TunnelReadWriteLive,
      ),
    ),
  ),
) {}
