import { revalidateOnMount } from "@t3tools/client-runtime/state/runtime";
import type { DesktopBridge, DesktopWslState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, type AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

type DesktopWslStateBridge = Pick<DesktopBridge, "getWslState">;
const WSL_SEARCH_STALE_TIME_MS = 30_000;

class DesktopWslStateUnavailableError extends Schema.TaggedError<DesktopWslStateUnavailableError>()(
  "DesktopWslStateUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop WSL state is unavailable.";
  }
}

class DesktopWslStateLoadError extends Schema.TaggedError<DesktopWslStateLoadError>()(
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

function isStaleSearchResult(result: AsyncResult.AsyncResult<DesktopWslState, unknown>) {
  if (result.waiting || result._tag === "Initial") return false;
  const success =
    result._tag === "Success" ? result : Option.getOrUndefined(result.previousSuccess);
  return success === undefined || Date.now() - success.timestamp >= WSL_SEARCH_STALE_TIME_MS;
}

export const desktopWslStateAtom = Atom.transform(
  desktopWslStateCache,
  (get) => {
    const current = get(desktopWslStateCache);
    if (Option.isNone(get.self()) && isStaleSearchResult(current)) {
      let active = true;
      get.addFinalizer(() => {
        active = false;
      });
      // Defer the refresh so it can't notify another reader during React render.
      queueMicrotask(() => {
        if (active && isStaleSearchResult(get.once(desktopWslStateCache))) {
          get.refresh(desktopWslStateCache);
        }
      });
    }
    return current;
  },
  { initialValueTarget: desktopWslStateCache },
);

export const desktopWslAccessStateAtom = desktopWslStateCache.pipe(revalidateOnMount(0));

export function refreshDesktopWslState(): void {
  appAtomRegistry.refresh(desktopWslStateCache);
}
