import type { DesktopBackgroundServiceState, DesktopBridge } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { m } from "../i18n/messages";

type DesktopBackgroundServiceBridge = Pick<
  DesktopBridge,
  "getBackgroundServiceState" | "enableBackgroundService" | "disableBackgroundService"
>;

class DesktopBackgroundServiceUnavailableError extends Schema.TaggedError<DesktopBackgroundServiceUnavailableError>()(
  "DesktopBackgroundServiceUnavailableError",
  {},
) {
  override get message(): string {
    return m(msg("Background service management is unavailable."));
  }
}

class DesktopBackgroundServiceLoadError extends Schema.TaggedError<DesktopBackgroundServiceLoadError>()(
  "DesktopBackgroundServiceLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return m(msg("Failed to load the background service state."));
  }
}

export function getDesktopBackgroundServiceBridge():
  | Required<DesktopBackgroundServiceBridge>
  | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.desktopBridge;
  if (
    !bridge?.getBackgroundServiceState ||
    !bridge.enableBackgroundService ||
    !bridge.disableBackgroundService
  ) {
    return undefined;
  }
  return {
    getBackgroundServiceState: bridge.getBackgroundServiceState,
    enableBackgroundService: bridge.enableBackgroundService,
    disableBackgroundService: bridge.disableBackgroundService,
  };
}

const loadDesktopBackgroundServiceState = Effect.fn("loadDesktopBackgroundServiceState")(
  function* () {
    const bridge = getDesktopBackgroundServiceBridge();
    if (!bridge) {
      return yield* new DesktopBackgroundServiceUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopBackgroundServiceState> => bridge.getBackgroundServiceState(),
      catch: (cause) => new DesktopBackgroundServiceLoadError({ cause }),
    });
  },
);

export const desktopBackgroundServiceStateAtom = Atom.make(
  loadDesktopBackgroundServiceState(),
).pipe(
  Atom.keepAlive,
  Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
  Atom.withLabel("desktop:background-service:load"),
);

export function refreshDesktopBackgroundServiceState(): void {
  appAtomRegistry.refresh(desktopBackgroundServiceStateAtom);
}
