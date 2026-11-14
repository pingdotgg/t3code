// @effect-diagnostics globalTimers:off - The release timer runs in web and native clients, outside an Effect runtime.
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import { presentConnectionState } from "../connection/presentation.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import type { EnvironmentShellState, EnvironmentShellStatus } from "./shell.ts";

/**
 * How long fresh rows wait for environments that are still connecting. Each environment
 * gets its server data at its own time, and a list that follows each one moves once per
 * environment; within this time they move together.
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
  readonly status: EnvironmentShellStatus;
  /** The shell state's generation: it grows with each server snapshot. */
  readonly generation: number;
  /** The connection is up or on its first attempt, so fresh rows can come soon. */
  readonly connecting: boolean;
  /** How many times the user moved or removed a row of this environment. */
  readonly rowActions: number;
}

interface SteadyShell {
  readonly shown: OrchestrationV2ShellSnapshot | null;
  readonly shownSequence: number | null;
  readonly shownGeneration: number;
  /** The rows were shown while live, so each live change shows at once. */
  readonly following: boolean;
  /** The rows hold a server snapshot of the connection that is synchronizing. */
  readonly caughtUp: boolean;
  /** The `rowActions` count when the rows last showed while live. */
  readonly rowActions: number;
}

export interface SteadyShellsState {
  readonly shells: ReadonlyMap<EnvironmentId, SteadyShell>;
  /** When held rows show at the latest; null while none wait. */
  readonly releaseAt: number | null;
}

export const EMPTY_STEADY_SHELLS_STATE: SteadyShellsState = { shells: new Map(), releaseAt: null };

/**
 * Decides which snapshot of each environment a thread list shows. New server rows wait for
 * a complete state (a server snapshot, live, or disconnected), then show with every other
 * environment that has one: at once when no other owes its rows, else when the window ends.
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
  let othersOweRows = false;
  const show = (
    input: SteadyShellInput,
    caughtUp: boolean,
    current: SteadyShell | undefined,
  ): SteadyShell => ({
    shown: input.snapshot,
    shownSequence: input.serverSequence,
    shownGeneration: input.generation,
    following: input.status === "live",
    caughtUp,
    rowActions:
      input.status === "live" || current === undefined ? input.rowActions : current.rowActions,
  });
  const keep = (input: SteadyShellInput, next: SteadyShell, current: SteadyShell | undefined) => {
    othersOweRows ||= input.status === "synchronizing" && input.connecting && !next.caughtUp;
    const same =
      current !== undefined &&
      current.shown === next.shown &&
      current.shownSequence === next.shownSequence &&
      current.shownGeneration === next.shownGeneration &&
      current.following === next.following &&
      current.caughtUp === next.caughtUp &&
      current.rowActions === next.rowActions;
    shells.set(input.environmentId, same ? current : next);
  };
  for (const input of inputs) {
    const current = previous.shells.get(input.environmentId);
    const synchronizing = input.status === "synchronizing";
    if (current === undefined) {
      keep(input, show(input, false, current), current);
      continue;
    }
    const newSnapshot = input.generation > current.shownGeneration;
    // Without new server data the change is local (cached links, rows loaded on demand), and
    // an environment that shows nothing (its cache is not read yet) has nothing to hold back.
    const local =
      current.shown === null || (input.serverSequence === current.shownSequence && !newSnapshot);
    // The hold stops changes the user did not cause. After the user moves or removes a row,
    // the environment's rows follow the live data until it is live.
    const userActed = input.rowActions !== current.rowActions;
    if (local || userActed || (input.status === "live" && current.following)) {
      const caughtUp = synchronizing && (current.caughtUp || newSnapshot);
      keep(input, show(input, caughtUp, current), current);
    } else if (!synchronizing || newSnapshot) {
      waiting.push(input);
      shells.set(input.environmentId, current);
    } else {
      // Events that a synchronizing environment replays are complete only when it is live.
      keep(input, { ...current, following: false }, current);
    }
  }

  let releaseAt: number | null = null;
  if (waiting.length > 0) {
    releaseAt = previous.releaseAt ?? now + windowMs;
    if (!othersOweRows || now >= releaseAt) {
      releaseAt = null;
      for (const input of waiting) {
        const current = shells.get(input.environmentId);
        shells.set(input.environmentId, show(input, input.status === "synchronizing", current));
      }
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
  readonly shellStateAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly rowActionsAtom: (environmentId: EnvironmentId) => Atom.Atom<number>;
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
      const shell = get(input.shellStateAtom(environmentId));
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
        status: shell.status,
        generation: shell.generation,
        // A retry after a failure can take minutes, so it is not waited for until it connects.
        connecting: phase === "connecting" || phase === "connected",
        rowActions: get(input.rowActionsAtom(environmentId)),
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

  // Reads the live snapshots too, so it is current when a handler reads it once.
  const holdingAtom = Atom.make((get) => {
    const { shells } = get(stateAtom);
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      if (shells.get(environmentId)?.shown !== get(input.snapshotAtom(environmentId))) return true;
    }
    return false;
  }).pipe(Atom.withLabel("steady-shells-holding"));

  return {
    /** The snapshot a thread list shows for an environment. */
    snapshotAtom,
    /** True while a list shows rows older than the server data the client holds. */
    holdingAtom,
  };
}
