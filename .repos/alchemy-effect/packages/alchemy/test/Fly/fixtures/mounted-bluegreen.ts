import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Site = Fly.App("Site");

export default class MountedBlueGreen extends Fly.Service<MountedBlueGreen>()(
  "Mounted",
  {
    app: Site,
    main: import.meta.url,
    services: [],
    checks: { ready: { type: "http", port: 3000, path: "/" } },
    deploy: { strategy: "bluegreen" },
  },
  Effect.gen(function* () {
    yield* Fly.MountVolume({ path: "/data", sizeGb: 1 });
    return { fetch: Effect.succeed(HttpServerResponse.text("ready")) };
  }).pipe(Effect.provide(Fly.MountVolumeLive)),
) {}
