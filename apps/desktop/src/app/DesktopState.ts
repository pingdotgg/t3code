import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
    /**
     * While Home is on, the renderer relays its calls to other environments.
     * On macOS, closing the window then hides it so the relay keeps running.
     */
    readonly keepAliveOnClose: Ref.Ref<boolean>;
  }
>()("@t3tools/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  keepAliveOnClose: Ref.make(false),
});

export const layer = Layer.effect(DesktopState, make);
