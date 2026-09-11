import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PrismaHostConnection } from "./db.ts";

class PrismaHostContainer extends Cloudflare.Container<PrismaHostContainer>()(
  "PrismaHostContainer",
  Effect.gen(function* () {
    const connection = yield* PrismaHostConnection;
    return {
      // Template string, not `path.join(import.meta.dirname, …)`: this module is
      // bundled into the Worker and `import.meta.dirname` is undefined there.
      context: `${import.meta.dirname}/../sqlreach/context`,
      env: {
        DATABASE_URL: connection.directConnectionString,
      },
      observability: { logs: { enabled: true } },
    };
  }),
) {}

/**
 * Durable Object that binds the {@link PrismaHostContainer} and exposes the
 * probe server's routes to the Worker.
 */
export class PrismaHostContainerObject extends Cloudflare.DurableObject<PrismaHostContainerObject>()(
  "PrismaHostContainerObject",
  Effect.gen(function* () {
    const container = yield* PrismaHostContainer;

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
      Cloudflare.Containers.layer(PrismaHostContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
