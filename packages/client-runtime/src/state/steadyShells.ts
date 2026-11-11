// @effect-diagnostics globalTimers:off - The release timer runs in web and native clients, outside an Effect runtime.
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import { presentConnectionState } from "../connection/presentation.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import type { EnvironmentShellStatus } from "./shell.ts";

/**
 * How long synchronized rows wait for environments that are still connecting. Each
 * environment synchronizes at its own time, and a list that follows each one moves once
 * per environment; within this time they move together.
 */
const STEADY_SHELL_RELEASE_WINDOW_MS = 2_000;

export interface SteadyShellInput {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationV2ShellSnapshot | null;
  /**
   * The snapshot's server sequence. It moves with new server data and with nothing else, and
   * it comes from the snapshot itself: a second atom could be one update behind the rows.
   */
  readonly serverSequence: number | null;
  /** The shell is synchronized with its server. */
  readonly live: boolean;
  /** A first connection attempt or its synchronization is running, so it can be live soon. */
  readonly inFlight: boolean;
}

interface SteadyShell {
  readonly shown: OrchestrationV2ShellSnapshot | null;
  readonly shownSequence: number | null;
  /** False while `shown` holds back newer server data. */
  readonly following: boolean;
}

export interface SteadyShellsState {
  readonly shells: ReadonlyMap<EnvironmentId, SteadyShell>;
  /** When held rows show at the latest; null while none wait. */
  readonly releaseAt: number | null;
}

export const EMPTY_STEADY_SHELLS_STATE: SteadyShellsState = { shells: new Map(), releaseAt: null };

/**
 * Decides which snapshot of each environment a thread list shows. Rows stay as shown until
 * their environment synchronizes, then show with every environment that synchronized: at once
 * when no other can be live soon, else when the window the first one opened ends.
 * Returns `previous` itself when nothing changes.
 */
export function stepSteadyShells(
  previous: SteadyShellsState,
  inputs: ReadonlyArray<SteadyShellInput>,
  now: number,
  windowMs = STEADY_SHELL_RELEASE_WINDOW_MS,
): SteadyShellsState {
  const shells = new Map<EnvironmentId, SteadyShell>();
  const waiting: Array<SteadyShellInput> = [];
  let othersInFlight = false;
  const follow = (input: SteadyShellInput, following: boolean): SteadyShell => ({
    shown: input.snapshot,
    shownSequence: input.serverSequence,
    following,
  });
  const keep = (environmentId: EnvironmentId, next: SteadyShell, current: SteadyShell) =>
    shells.set(
      environmentId,
      current.shown === next.shown &&
        current.shownSequence === next.shownSequence &&
        current.following === next.following
        ? current
        : next,
    );
  for (const input of inputs) {
    const current = previous.shells.get(input.environmentId);
    if (current === undefined) {
      othersInFlight ||= !input.live && input.inFlight;
      shells.set(input.environmentId, follow(input, input.live));
    } else if (!input.live) {
      othersInFlight ||= input.inFlight;
      // Without new server data the change is local (cached links, rows loaded on demand), and
      // an environment that shows nothing (its cache is not read yet) has nothing to hold back.
      const local = current.shown === null || input.serverSequence === current.shownSequence;
      keep(
        input.environmentId,
        local ? follow(input, false) : { ...current, following: false },
        current,
      );
    } else if (current.following) {
      keep(input.environmentId, follow(input, true), current);
    } else {
      waiting.push(input);
      shells.set(input.environmentId, current);
    }
  }

  let releaseAt: number | null = null;
  if (waiting.length > 0) {
    releaseAt = previous.releaseAt ?? now + windowMs;
    if (!othersInFlight || now >= releaseAt) {
      releaseAt = null;
      for (const input of waiting) shells.set(input.environmentId, follow(input, true));
    }
  }

  const unchanged =
    releaseAt === previous.releaseAt &&
    shells.size === previous.shells.size &&
    [...shells].every(([environmentId, shell]) => previous.shells.get(environmentId) === shell);
  return unchanged ? previous : { shells, releaseAt };
}

/**
 * Snapshots for lists that arrange threads across environments; see `stepSteadyShells`.
 * Point reads (a thread's own shell, route checks) keep the live snapshot, where a row
 * that the server just sent must not look missing.
 */
export function createSteadyShellAtoms<E>(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  readonly statusAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellStatus>;
  readonly connectionStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, E>>;
}) {
  const now = () => {
    // @effect-diagnostics-next-line globalDate:off - The release window is wall-clock time.
    return Date.now();
  };
  // Outlives the atom's rebuilds, and its unmount while no list is on screen.
  let state = EMPTY_STEADY_SHELLS_STATE;
  const stateAtom = Atom.make((get) => {
    const inputs: Array<SteadyShellInput> = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const snapshot = get(input.snapshotAtom(environmentId));
      const live = get(input.statusAtom(environmentId)) === "live";
      const connection = AsyncResult.getOrElse(
        get(input.connectionStateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      );
      // An enabled environment starts out connecting, before its supervisor reports.
      const phase =
        connection === AVAILABLE_CONNECTION_STATE
          ? "connecting"
          : presentConnectionState(connection).phase;
      inputs.push({
        environmentId,
        snapshot,
        serverSequence: snapshot?.snapshotSequence ?? null,
        live,
        // A retry after a failure can take minutes, so only a first attempt is waited for.
        inFlight: !live && (phase === "connecting" || phase === "connected"),
      });
    }
    state = stepSteadyShells(state, inputs, now());
    if (state.releaseAt !== null) {
      const timer = setTimeout(() => get.refreshSelf(), Math.max(0, state.releaseAt - now()));
      get.addFinalizer(() => clearTimeout(timer));
    }
    return state;
  }).pipe(Atom.withLabel("steady-shells"));

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): OrchestrationV2ShellSnapshot | null =>
        get(stateAtom).shells.get(environmentId)?.shown ?? null,
    ).pipe(Atom.withLabel(`steady-shell-snapshot:${environmentId}`)),
  );

  /** The snapshot a thread list shows for an environment. */
  return { snapshotAtom };
}
