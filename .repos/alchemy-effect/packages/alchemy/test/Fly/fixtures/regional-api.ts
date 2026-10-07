import * as Fly from "@/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * A Service in two regions with a Volume per Machine. It answers with the
 * region of the Machine that served the request.
 */
export default class RegionalApi extends Fly.Service<RegionalApi>()(
  "RegionalApi",
  {
    main: import.meta.url,
    region: ["iad", "lhr"],
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    yield* Fly.MountVolume({ path: "/data", sizeGb: 1 });
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(yield* Config.String("FLY_REGION"));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Fly.MountVolumeLive)),
) {}
