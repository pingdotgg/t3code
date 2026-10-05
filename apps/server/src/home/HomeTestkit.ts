import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FleetBroker from "./FleetBroker.ts";
import * as FleetService from "./FleetService.ts";
import * as HomeService from "./HomeService.ts";

/** Home services for tests whose caller is never Home. */
export const notHomeLayer = Layer.mergeAll(
  Layer.mock(HomeService.HomeService)({
    available: false,
    isHome: () => Effect.succeed(false),
  }),
  Layer.mock(FleetService.FleetService)({}),
  Layer.mock(FleetBroker.FleetBroker)({}),
);
