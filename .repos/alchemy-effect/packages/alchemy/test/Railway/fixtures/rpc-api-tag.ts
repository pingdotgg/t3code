import { Service } from "@/Railway/Service.ts";
import type * as Effect from "effect/Effect";

export class Api extends Service<Api>()("Api") {
  ping!: () => Effect.Effect<string>;
}
