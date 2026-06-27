import type { DesktopBridge, DesktopWslState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
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
  return createDesktopWslStateAtoms(getBridge).stateAtom;
}

function createDesktopWslStateAtoms(getBridge: () => DesktopWslStateBridge | undefined) {
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

  const loadAtom = Atom.make(loadDesktopWslState()).pipe(
    Atom.swr({
      staleTime: DESKTOP_WSL_STATE_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:wsl-state:load"),
  );

  const snapshotAtom = Atom.make<DesktopWslState | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("desktop:wsl-state:snapshot"),
  );

  const stateAtom = Atom.make((get) => {
    const snapshot = get(snapshotAtom);
    return snapshot ? AsyncResult.success(snapshot) : get(loadAtom);
  }).pipe(Atom.keepAlive, Atom.withLabel("desktop:wsl-state"));

  return { loadAtom, snapshotAtom, stateAtom };
}

const desktopWslStateAtoms = createDesktopWslStateAtoms(getDesktopWslStateBridge);

export const desktopWslStateAtom = desktopWslStateAtoms.stateAtom;

export function refreshDesktopWslState(): void {
  appAtomRegistry.set(desktopWslStateAtoms.snapshotAtom, null);
  appAtomRegistry.refresh(desktopWslStateAtoms.loadAtom);
}

export function setDesktopWslStateSnapshot(state: DesktopWslState): void {
  appAtomRegistry.set(desktopWslStateAtoms.snapshotAtom, state);
}
