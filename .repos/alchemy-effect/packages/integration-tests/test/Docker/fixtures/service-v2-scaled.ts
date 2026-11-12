import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SERVICE_EXTERNAL_PORT } from "./service.ts";

/**
 * A non-code change to `./service-v2.ts`: it bundles the same `main`, so the
 * content hash is unchanged, and only `replicas` differs. Deploying it after
 * `./service-v2.ts` updates the service without building a new image.
 */
export default class TestServiceV2Scaled extends Docker.Service<TestServiceV2Scaled>()(
  "DockerPlatformService",
  {
    main: `${import.meta.dirname}/service-v2.ts`,
    port: 3000,
    ports: [{ external: SERVICE_EXTERNAL_PORT, internal: 3000 }],
    replicas: 2,
  },
  // Never runs: the bundle is built from `./service-v2.ts`.
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("unused")) }),
) {}
