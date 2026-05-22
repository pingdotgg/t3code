import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

export const uuidv4 = () => Effect.runSync(Random.nextUUIDv4);
