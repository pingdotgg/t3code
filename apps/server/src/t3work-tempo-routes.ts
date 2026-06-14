import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import { errorResponse, okJson, readJsonBody } from "./t3work-atlassian-http.ts";
import {
  loadT3workTempoCapacity,
  loadTempoToken,
  saveTempoToken,
  type T3workTempoCapacityInput,
} from "./t3work-tempo.ts";

const t3workTempoCapacityRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/tempo/capacity",
  Effect.gen(function* () {
    const input = yield* readJsonBody<T3workTempoCapacityInput>();
    const result = yield* loadT3workTempoCapacity(input);
    return okJson(result);
  }).pipe(Effect.catch(errorResponse)),
);

const t3workTempoTokenRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/tempo/token",
  Effect.gen(function* () {
    const input = yield* readJsonBody<{ readonly token?: string | null }>();
    yield* saveTempoToken(input.token ?? null);
    const token = yield* loadTempoToken;
    return okJson({ configured: token !== null });
  }).pipe(Effect.catch(errorResponse)),
);

const t3workTempoStatusRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3work/tempo/status",
  Effect.gen(function* () {
    const token = yield* loadTempoToken;
    return okJson({ configured: token !== null });
  }).pipe(Effect.catch(errorResponse)),
);

export const t3workTempoRouteLayer = Layer.mergeAll(
  t3workTempoCapacityRouteLayer,
  t3workTempoTokenRouteLayer,
  t3workTempoStatusRouteLayer,
);
