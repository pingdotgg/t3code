import { AuthRelayReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { ServerAdvertisedEndpoints } from "./ServerAdvertisedEndpoints.ts";

// `relay:read` is part of the standard client scope set, so an ordinary paired
// or relay-tunneled client can discover the direct endpoints it might promote
// to. `access:read` would restrict this to admin clients.
export const remoteAccessHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "remoteAccess",
  Effect.fnUntraced(function* (handlers) {
    const advertisedEndpoints = yield* ServerAdvertisedEndpoints;
    return handlers.handle(
      "advertisedEndpoints",
      Effect.fn("environment.remoteAccess.advertisedEndpoints")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthRelayReadScope);
        return yield* advertisedEndpoints.getEndpoints;
      }),
    );
  }),
);
