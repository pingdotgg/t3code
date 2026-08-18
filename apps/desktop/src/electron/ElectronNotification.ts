import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export class ElectronNotificationShowError extends Schema.TaggedErrorClass<ElectronNotificationShowError>()(
  "ElectronNotificationShowError",
  {
    titleLength: Schema.Number,
    bodyLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to show an Electron notification with a ${this.titleLength}-character title and a ${this.bodyLength}-character body.`;
  }
}

export interface ElectronNotificationShowInput {
  readonly title: string;
  readonly body: string;
  /** Invoked on the main thread when the user activates the notification. */
  readonly onClick: () => void;
}

/**
 * Thin wrapper over Electron's `Notification`, mirroring `ElectronDialog`: the
 * services that decide *whether* to notify stay testable because the only
 * Electron surface they touch is this interface.
 */
export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    /** False when the OS has no notification support; callers must not treat it as an error. */
    readonly isSupported: Effect.Effect<boolean>;
    /**
     * Presents a notification and returns a handle for dismissing it. The
     * handle keeps the underlying object reachable — a garbage-collected
     * `Notification` disappears from the OS notification centre on some
     * platforms — so callers own its lifetime.
     */
    readonly show: (
      input: ElectronNotificationShowInput,
    ) => Effect.Effect<ElectronNotificationHandle, ElectronNotificationShowError>;
  }
>()("@t3tools/desktop/electron/ElectronNotification") {}

export interface ElectronNotificationHandle {
  readonly close: Effect.Effect<void>;
}

export const make = ElectronNotification.of({
  isSupported: Effect.sync(() => Electron.Notification.isSupported()),
  show: Effect.fn("desktop.electron.notification.show")(function* (input) {
    return yield* Effect.try({
      try: (): ElectronNotificationHandle => {
        const notification = new Electron.Notification({
          title: input.title,
          body: input.body,
        });
        notification.on("click", input.onClick);
        notification.show();
        return {
          close: Effect.sync(() => {
            notification.close();
          }),
        };
      },
      catch: (cause) =>
        new ElectronNotificationShowError({
          titleLength: input.title.length,
          bodyLength: input.body.length,
          cause,
        }),
    });
  }),
});

export const layer = Layer.succeed(ElectronNotification, make);
