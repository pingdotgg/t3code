import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ColdStartLifecycleShape {
  readonly run: Effect.Effect<void, never, never>;
}

export class ColdStartLifecycle extends ServiceMap.Service<
  ColdStartLifecycle,
  ColdStartLifecycleShape
>()("t3/orchestration/Services/ColdStartLifecycle") {}
