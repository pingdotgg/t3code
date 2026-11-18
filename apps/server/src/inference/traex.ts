import * as Effect from "effect/Effect";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";

export const TRAEX_CONSUMER_PATH = "/api/inference/traex/resolve";
export const TRAEX_HOST_PATH = "/api/inference/traex/host";

export const TRAEX_CONSUMER_SECRET = "traex-consumer-route";

export const traexConsumerRouteKey = (store: ServerSecretStore["Service"]) =>
  store
    .getOrCreateRandom(TRAEX_CONSUMER_SECRET, 32)
    .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
