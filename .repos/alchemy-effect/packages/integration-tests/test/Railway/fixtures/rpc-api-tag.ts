import { Service } from "@alchemy.run/railway/Service";
import type * as Effect from "effect/Effect";

export class Api extends Service<Api>()("Api") {
  ping!: () => Effect.Effect<string>;
}
