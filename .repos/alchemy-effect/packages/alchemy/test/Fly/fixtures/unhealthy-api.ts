import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { API_PORT } from "./shared.ts";

export const UnhealthySite = Fly.App("UnhealthySite");

export default class UnhealthyApi extends Fly.Service<UnhealthyApi>()(
  "UnhealthyApi",
  {
    app: UnhealthySite,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    count: 2,
    services: [
      {
        protocol: "tcp",
        internalPort: API_PORT,
        autostart: true,
        autostop: "off",
        ports: [{ port: 80, handlers: ["http"] }],
        checks: [
          {
            type: "http",
            port: API_PORT,
            path: "/health",
            interval: "5s",
            timeout: "2s",
            gracePeriod: "1s",
          },
        ],
      },
    ],
  },
  Effect.gen(function* () {
    yield* Fly.MountVolume({ path: "/data", sizeGb: 1 });
    return {
      fetch: Effect.succeed(HttpServerResponse.empty({ status: 503 })),
    };
  }).pipe(Effect.provide(Fly.MountVolumeLive)),
) {}
