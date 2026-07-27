import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture that exercises all three Cloudflare tunnel
 * runtime bindings from a single Worker:
 *
 * - {@link Cloudflare.Tunnel.ReadTunnel} — read-only (`/read`)
 * - {@link Cloudflare.Tunnel.WriteTunnel} — mutating (`/write`)
 * - {@link Cloudflare.Tunnel.ReadWriteTunnel} — full CRUD (`/readwrite`)
 *
 * Each binding provisions its own least-privilege {@link Cloudflare.ApiToken.AccountApiToken}
 * (binding the token's outputs into the Worker) and the routes below run a
 * self-contained scenario per binding so the test can assert one behavior each.
 */
export default class TunnelEffectWorker extends Cloudflare.Worker<TunnelEffectWorker>()(
  "TunnelEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const read = yield* Cloudflare.Tunnel.ReadTunnel();
    const write = yield* Cloudflare.Tunnel.WriteTunnel();
    const tunnels = yield* Cloudflare.Tunnel.ReadWriteTunnel();

    // Tests use deterministic tunnel names, and Cloudflare rejects duplicate
    // names — delete any leftover tunnel from a previously crashed run so
    // create always succeeds.
    const purge = Effect.fn(function* (...names: string[]) {
      for (const name of names) {
        const list = yield* tunnels
          .list({ name, isDeleted: false })
          .pipe(Effect.orDie);
        yield* Effect.forEach(
          (list.result ?? []).filter((t) => t.name === name && t.id),
          (t) => tunnels.delete(t.id!).pipe(Effect.orDie),
        );
      }
    });

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
          yield* purge(name);
          const tunnel = yield* write
            .create({ name, configSrc: "cloudflare" })
            .pipe(Effect.orDie);
          yield* write.delete(tunnel.id!).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            id: tunnel.id,
            deleted: true,
          });
        }

        // Read + write: drive the full CRUD surface end to end. Purge the
        // renamed variant too — a crash after the rename step would
        // otherwise leak it forever.
        if (url.pathname === "/readwrite") {
          yield* purge(name, `${name}-renamed`);
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
        Cloudflare.Tunnel.ReadTunnelBinding,
        Cloudflare.Tunnel.WriteTunnelBinding,
        Cloudflare.Tunnel.ReadWriteTunnelBinding,
      ),
    ),
  ),
) {}
