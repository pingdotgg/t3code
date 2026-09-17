import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Deterministic port the test's host-side HTTP server listens on. It stands
 * in for a local dev database (e.g. the `@prisma/dev` server) bound to the
 * developer machine's loopback — the container must be able to reach it even
 * though `localhost` inside the container is the container itself.
 */
export const HOST_PROBE_PORT = 42117;

/**
 * A literal local Prisma Postgres URL shape (`@prisma/dev` hands these out
 * in dev). Prisma's client only speaks plain HTTP to `prisma+postgres://`
 * hosts that look local (`localhost`/`127.0.0.1`/`[::1]`), so whatever the
 * dev runtime rewrites the host to must still contain "localhost".
 */
export const PPG_URL = "prisma+postgres://localhost:51216/?api_key=test-key";

/**
 * Cloud SQL URLs (Neon pooled, PlanetScale Postgres pooled, PlanetScale
 * MySQL). The rewrite must leave these hosts alone — they are not loopback,
 * and mangling them is how a "fix localhost" change would break Neon /
 * PlanetScale from a container.
 */
export const NEON_URL =
  "postgres://neondb_owner:secret@ep-cool-name-123456-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
export const PLANETSCALE_PG_URL =
  "postgresql://user:secret@xxxx.pg.psdb.cloud:6432/postgres?sslmode=verify-full";
export const PLANETSCALE_MYSQL_URL =
  "mysql://user:secret@aws.connect.psdb.cloud:3306/db?sslaccept=strict";

class HostReachContainer extends Cloudflare.Container<HostReachContainer>()(
  "HostReachContainer",
  {
    // Template string, not `path.join(import.meta.dirname, …)`: this module is
    // bundled into the Worker and `import.meta.dirname` is undefined there.
    context: `${import.meta.dirname}/context`,
    env: {
      TARGET_URL: `http://localhost:${HOST_PROBE_PORT}/hello`,
      PPG_URL,
      NEON_URL,
      PLANETSCALE_PG_URL,
      PLANETSCALE_MYSQL_URL,
    },
    observability: { logs: { enabled: true } },
  },
) {}

/**
 * Durable Object that binds the {@link HostReachContainer} and exposes the
 * probe server's routes to the Worker.
 */
export class HostReachContainerObject extends Cloudflare.DurableObject<HostReachContainerObject>()(
  "HostReachContainerObject",
  Effect.gen(function* () {
    const container = yield* HostReachContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      const get = (path: string) =>
        Effect.gen(function* () {
          const response = yield* fetch(
            HttpClientRequest.get(`http://container${path}`),
          );
          return yield* response.text;
        });

      return {
        getEnv: () => get("/env"),
        getProbe: () => get("/probe"),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(HostReachContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
