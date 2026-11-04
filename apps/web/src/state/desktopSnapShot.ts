import type { DesktopSnapShotState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { getDesktopSnapShotBridge } from "../lib/desktopSnapShot";

export interface SnapShotSetupError {
  readonly title: string;
  readonly message: string;
}

export function snapShotSetupError(title: string, error: unknown): SnapShotSetupError {
  return { title, message: error instanceof Error ? error.message : "Try again." };
}

export interface DesktopSnapShotLoad {
  readonly state: DesktopSnapShotState | null;
  /** Why the last background read (load, focus, shortcut change) failed; a later success clears it. */
  readonly refreshError: SnapShotSetupError | null;
}

const EMPTY_LOAD: DesktopSnapShotLoad = { state: null, refreshError: null };

// Only the newest read lands, so a slow answer cannot regress the state. Dropping the atom bumps
// it too, so a read that was in flight when the page closed does not seed the next visit.
let stateRequestId = 0;

/**
 * The desktop capture state. Reading it starts a load, then re-reads on window focus (the user
 * may have changed OS permissions) and when the desktop reports a shortcut change.
 */
export const desktopSnapShotAtom = Atom.writable(
  (get): DesktopSnapShotLoad => {
    get.addFinalizer(() => {
      stateRequestId++;
    });
    const bridge = getDesktopSnapShotBridge();
    if (!bridge) return EMPTY_LOAD;
    const refresh = () =>
      void refreshDesktopSnapShotState(get.registry, (error) => {
        get.setSelf({
          ...Option.getOrElse(get.self<DesktopSnapShotLoad>(), () => EMPTY_LOAD),
          refreshError: snapShotSetupError("Couldn't check capture setup", error),
        });
      });
    window.addEventListener("focus", refresh);
    get.addFinalizer(() => window.removeEventListener("focus", refresh));
    get.addFinalizer(
      bridge.onSnapShotEvent((event) => {
        if (event.type === "shortcut-changed") refresh();
      }),
    );
    refresh();
    return EMPTY_LOAD;
  },
  (ctx, value: DesktopSnapShotLoad) => ctx.setSelf(value),
).pipe(Atom.withLabel("desktop:snap-shot:state"));

/**
 * Reads the capture state now and stores it. `onError` hears only a failure of the newest read;
 * the result is `undefined` whenever this read did not produce the current state.
 */
export async function refreshDesktopSnapShotState(
  registry: AtomRegistry.AtomRegistry,
  onError: (error: unknown) => void,
): Promise<DesktopSnapShotState | undefined> {
  const bridge = getDesktopSnapShotBridge();
  if (!bridge) return undefined;
  const requestId = ++stateRequestId;
  try {
    const next = await bridge.getSnapShotState();
    if (requestId === stateRequestId) {
      registry.set(desktopSnapShotAtom, { state: next, refreshError: null });
    }
    return next;
  } catch (error) {
    if (requestId === stateRequestId) onError(error);
    return undefined;
  }
}
