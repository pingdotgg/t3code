import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface SandboxNotificationPayload {
  readonly event: "sandbox_auto_stopped" | "sandbox_warning";
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string;
  readonly priority?: "default" | "high";
}

export class SandboxNotifier extends Context.Service<
  SandboxNotifier,
  {
    readonly notify: (payload: SandboxNotificationPayload) => Effect.Effect<void>;
  }
>()("t3/sandboxes/SandboxNotificationHook/SandboxNotifier") {}
