import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PlanetscaleHostRole } from "./db.ts";

class PlanetscaleHostContainer extends Cloudflare.Container<PlanetscaleHostContainer>()(
  "PlanetscaleHostContainer",
  Effect.gen(function* () {
    const role = yield* PlanetscaleHostRole;
    return {
      context: `${import.meta.dirname}/../sqlreach/context`,
      env: {
        DATABASE_URL: role.connectionUrlPooled,
      },
      observability: { logs: { enabled: true } },
    };
  }),
) {}

export class PlanetscaleHostContainerObject extends Cloudflare.DurableObject<PlanetscaleHostContainerObject>()(
  "PlanetscaleHostContainerObject",
  Effect.gen(function* () {
    const container = yield* PlanetscaleHostContainer;

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
      Cloudflare.Containers.layer(PlanetscaleHostContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
