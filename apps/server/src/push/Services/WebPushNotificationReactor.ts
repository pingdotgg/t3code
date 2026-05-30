import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WebPushNotificationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WebPushNotificationReactor extends Context.Service<
  WebPushNotificationReactor,
  WebPushNotificationReactorShape
>()("salchi/push/Services/WebPushNotificationReactor") {}
