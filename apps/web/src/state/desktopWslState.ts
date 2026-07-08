import type { DesktopBridge, DesktopWslState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const DESKTOP_WSL_STATE_STALE_TIME_MS = 30_000;

type DesktopWslStateBridge = Pick<DesktopBridge, "getWslState">;

class DesktopWslStateUnavailableError extends Schema.TaggedErrorClass<DesktopWslStateUnavailableError>()(
  "DesktopWslStateUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop WSL state is unavailable.";
  }
}

class DesktopWslStateLoadError extends Schema.TaggedErrorClass<DesktopWslStateLoadError>()(
  "DesktopWslStateLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load WSL state.";
  }
}

function getDesktopWslStateBridge(): DesktopWslStateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopWslStateAtom(getBridge: () => DesktopWslStateBridge | undefined) {
  const loadDesktopWslState = Effect.fn("loadDesktopWslState")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopWslStateUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopWslState> => bridge.getWslState(),
      catch: (cause) => new DesktopWslStateLoadError({ cause }),
    });
  });

  return Atom.make(loadDesktopWslState()).pipe(
    Atom.swr({
      staleTime: DESKTOP_WSL_STATE_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:wsl-state:load"),
  );
}

export const desktopWslStateAtom = createDesktopWslStateAtom(getDesktopWslStateBridge);

export function refreshDesktopWslState(): void {
  appAtomRegistry.refresh(desktopWslStateAtom);
}
