import { AuthTerminalOperateScope, type EnvironmentId } from "@t3tools/contracts";
import type { PinnedPortForward } from "@t3tools/contracts/settings";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import {
  getClientSettings,
  persistClientSettingsUpdate,
  subscribeClientSettings,
} from "../hooks/useSettings";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { canForwardPorts, previewBridge } from "./portForwards";
import { environmentPresentations } from "./presentation";
import { environmentSession, sessionHasScope } from "./session";

type ForwardAvailability = "ready" | "waiting" | "tunnel-disabled" | "access-required";
type ForwardFailure = "port-in-use" | "same-machine" | "unreachable" | "failed";
type PinnedPortForwardStatus =
  | Exclude<ForwardAvailability, "ready">
  | ForwardFailure
  | "starting"
  | "forwarded";

export interface PinnedPortForwardState extends PinnedPortForward {
  readonly status: PinnedPortForwardStatus;
}

const EMPTY_PINS: ReadonlyArray<PinnedPortForward> = [];
const pinsAtom = Atom.make(EMPTY_PINS).pipe(Atom.withLabel("desktop:port-forward-pins"));

const availabilityAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ForwardAvailability => {
    const environment = get(environmentPresentations.presentationAtom(environmentId));
    if (!environment?.entry.enabled || environment.connection.phase !== "connected")
      return "waiting";
    if (environment.serverConfig === null) return "waiting";
    if (!canForwardPorts(environment)) return "tunnel-disabled";
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (!AsyncResult.isSuccess(session)) return "waiting";
    return sessionHasScope(session, AuthTerminalOperateScope) ? "ready" : "access-required";
  }),
);

function classifyStartFailure(error: unknown): ForwardFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("LoopbackTunnelPortInUseError")) return "port-in-use";
  if (message.includes("LoopbackTunnelSameMachineError")) return "same-machine";
  if (message.includes("LoopbackTunnelUnavailableError")) return "unreachable";
  return "failed";
}

class ForwardTarget extends Data.Class<Pick<PinnedPortForward, "environmentId" | "remotePort">> {}

const retryAttemptAtom = Atom.family((_target: ForwardTarget) => Atom.make(0));

const bindingAtom = Atom.family((target: ForwardTarget) =>
  Atom.make((get): Stream.Stream<PinnedPortForwardStatus> => {
    get(retryAttemptAtom(target));
    const { environmentId, remotePort } = target;
    const availability = get(availabilityAtom(environmentId));
    if (availability !== "ready") return Stream.succeed(availability);
    const bridge = previewBridge();
    if (!bridge) return Stream.succeed("tunnel-disabled");
    const owner = randomUUID();
    // Hold the listener only while the pin is configured and the environment can be reached.
    const binding = Stream.unwrap(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => bridge.forwardPort(environmentId, remotePort, { owner, pinned: true }),
          catch: classifyStartFailure,
        }).pipe(Effect.as("forwarded" as const), Effect.catch(Effect.succeed)),
        (status) =>
          status === "forwarded"
            ? Effect.promise(() => bridge.stopPortForward(environmentId, remotePort, owner)).pipe(
                Effect.ignoreCause,
              )
            : Effect.void,
      ).pipe(Effect.map((status) => Stream.succeed(status).pipe(Stream.concat(Stream.never)))),
    );
    return Stream.succeed("starting" as const).pipe(Stream.concat(binding));
  }),
);

export const pinnedPortForwardsAtom = Atom.make((get): ReadonlyArray<PinnedPortForwardState> => {
  if (!previewBridge()) return [];
  return get(pinsAtom).map((pin) => {
    const binding = get(
      bindingAtom(
        new ForwardTarget({ environmentId: pin.environmentId, remotePort: pin.remotePort }),
      ),
    );
    return {
      ...pin,
      status: AsyncResult.getOrElse(binding, () => "starting"),
    };
  });
}).pipe(Atom.withLabel("desktop:pinned-port-forwards"));

export function startPinnedPortForwards(): () => void {
  const syncPins = () => appAtomRegistry.set(pinsAtom, getClientSettings().pinnedPortForwards);
  const unsubscribe = subscribeClientSettings(syncPins);
  const unmount = appAtomRegistry.mount(pinnedPortForwardsAtom);
  syncPins();
  return () => {
    unsubscribe();
    appAtomRegistry.set(pinsAtom, EMPTY_PINS);
    unmount();
  };
}

function matchesPin(
  pin: PinnedPortForward,
  environmentId: EnvironmentId,
  remotePort: number,
): boolean {
  return pin.environmentId === environmentId && pin.remotePort === remotePort;
}

export async function pinPortForward(pin: PinnedPortForward): Promise<void> {
  await persistClientSettingsUpdate((settings) => ({
    ...settings,
    pinnedPortForwards: [
      ...settings.pinnedPortForwards.filter(
        (saved) => !matchesPin(saved, pin.environmentId, pin.remotePort),
      ),
      pin,
    ],
  }));
}

export async function unpinPortForward(
  environmentId: EnvironmentId,
  remotePort: number,
): Promise<void> {
  await persistClientSettingsUpdate((settings) => ({
    ...settings,
    pinnedPortForwards: settings.pinnedPortForwards.filter(
      (pin) => !matchesPin(pin, environmentId, remotePort),
    ),
  }));
}

export function retryPinnedPortForward(environmentId: EnvironmentId, remotePort: number): void {
  appAtomRegistry.update(
    retryAttemptAtom(new ForwardTarget({ environmentId, remotePort })),
    (value) => value + 1,
  );
}

export function canRetryPinnedPortForward(status: PinnedPortForwardStatus): boolean {
  return status === "port-in-use" || status === "unreachable" || status === "failed";
}
