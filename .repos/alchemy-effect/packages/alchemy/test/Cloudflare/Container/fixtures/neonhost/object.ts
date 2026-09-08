import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { NeonHostProject } from "./db.ts";

class NeonHostContainer extends Cloudflare.Container<NeonHostContainer>()(
  "NeonHostContainer",
  Effect.gen(function* () {
    const project = yield* NeonHostProject;
    return {
      context: `${import.meta.dirname}/../sqlreach/context`,
      env: {
        DATABASE_URL: project.pooledConnectionUri,
      },
      observability: { logs: { enabled: true } },
    };
  }),
) {}

export class NeonHostContainerObject extends Cloudflare.DurableObject<NeonHostContainerObject>()(
  "NeonHostContainerObject",
  Effect.gen(function* () {
    const container = yield* NeonHostContainer;

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
      Cloudflare.Containers.layer(NeonHostContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
