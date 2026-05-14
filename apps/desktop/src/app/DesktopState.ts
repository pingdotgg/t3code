import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface DesktopStateShape {
  readonly backendReady: Ref.Ref<boolean>;
  readonly quitting: Ref.Ref<boolean>;
}

export class DesktopState extends Context.Service<DesktopState, DesktopStateShape>()(
  "t3/desktop/State",
) {}

export const layer = Layer.effect(
  DesktopState,
  Effect.all({
    backendReady: Ref.make(false),
    quitting: Ref.make(false),
  }),
);
