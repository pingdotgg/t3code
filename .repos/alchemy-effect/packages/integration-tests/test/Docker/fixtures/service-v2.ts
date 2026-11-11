import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SERVICE_EXTERNAL_PORT } from "./service.ts";

/**
 * A code change to `./service.ts`: same logical id and props, different
 * program, so redeploying it rolls the existing service onto a new
 * content-addressed image.
 */
export default class TestServiceV2 extends Docker.Service<TestServiceV2>()(
  "DockerPlatformService",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ external: SERVICE_EXTERNAL_PORT, internal: 3000 }],
    replicas: 1,
  },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://service");
      if (url.pathname === "/health") {
        return yield* HttpServerResponse.json({ ok: true, version: 2 });
      }
      return HttpServerResponse.text("hello from docker service v2");
    }),
  }),
) {}
