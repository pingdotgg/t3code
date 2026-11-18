import { revalidateOnMount } from "@t3tools/client-runtime/state/runtime";
import type { DesktopBridge, DesktopWslState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { msg } from "gt-react";

import { m } from "../i18n/messages";

type DesktopWslStateBridge = Pick<DesktopBridge, "getWslState">;
const WSL_SEARCH_STALE_TIME_MS = 30_000;

class DesktopWslStateUnavailableError extends Schema.TaggedError<DesktopWslStateUnavailableError>()(
  "DesktopWslStateUnavailableError",
  {},
) {
  override get message(): string {
    return m(msg("Desktop WSL state is unavailable."));
  }
}

class DesktopWslStateLoadError extends Schema.TaggedError<DesktopWslStateLoadError>()(
  "DesktopWslStateLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return m(msg("Failed to load WSL state."));
  }
}

function getDesktopWslStateBridge(): DesktopWslStateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

function createDesktopWslStateAtom(getBridge: () => DesktopWslStateBridge | undefined) {
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
    Atom.keepAlive,
    Atom.withLabel("desktop:wsl-state:load"),
  );
}

const desktopWslStateCache = createDesktopWslStateAtom(getDesktopWslStateBridge);

export const desktopWslStateAtom = desktopWslStateCache.pipe(
  revalidateOnMount(WSL_SEARCH_STALE_TIME_MS),
);

export const desktopWslAccessStateAtom = desktopWslStateCache.pipe(revalidateOnMount(0));

export function refreshDesktopWslState(): void {
  appAtomRegistry.refresh(desktopWslStateCache);
}
