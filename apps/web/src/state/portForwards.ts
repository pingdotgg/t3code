import { useAtomValue } from "@effect/atom-react";
import type { DesktopPortForward, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

import { tunnelsEnvironmentLoopback } from "../browser/browserTargetResolver";
import { m } from "../i18n/messages";
import { environmentAtomList } from "./environmentAtomList";

const EMPTY_FORWARDS: ReadonlyArray<DesktopPortForward> = [];

const previewBridge = () =>
  typeof window === "undefined" ? undefined : window.desktopBridge?.preview;

/** Ports of other environments the desktop app forwards to this machine; empty elsewhere. */
const portForwardsAtom = Atom.make(
  Stream.callback<ReadonlyArray<DesktopPortForward>>((queue) =>
    Effect.gen(function* () {
      const bridge = previewBridge();
      if (!bridge) return yield* Effect.never;
      let changed = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onPortForwards((forwards) => {
            changed = true;
            Queue.offerUnsafe(queue, forwards);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const initial = yield* Effect.promise(() => bridge.listPortForwards());
      if (!changed) Queue.offerUnsafe(queue, initial);
      return yield* Effect.never;
    }),
  ),
  { initialValue: EMPTY_FORWARDS },
).pipe(Atom.keepAlive, Atom.withLabel("desktop:port-forwards"));

export function usePortForwards(): ReadonlyArray<DesktopPortForward> {
  return AsyncResult.getOrElse(useAtomValue(portForwardsAtom), () => EMPTY_FORWARDS);
}

/** Only the desktop app forwards, and only from environments it reaches through the tunnel. */
export const canForwardPorts = (target: ConnectionTarget | undefined): boolean =>
  previewBridge() !== undefined && tunnelsEnvironmentLoopback(target);

// A saved route can still lead back to this computer (its own Tailscale address, a relay), where
// a forward would only loop. Main probes it once a connection is up; hidden until it answers.
const onOtherMachineAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    Effect.promise(async () => {
      const bridge = previewBridge();
      return bridge !== undefined && !(await bridge.sharesLoopback(environmentId));
    }),
  ).pipe(
    Atom.map((result) => AsyncResult.getOrElse(result, () => false)),
    Atom.setIdleTTL(10 * 60_000),
    Atom.withLabel(`desktop:port-forward-other-machine:${environmentId}`),
  ),
);

const NOT_FORWARDABLE = Atom.make(false).pipe(Atom.withLabel("desktop:port-forward-none"));

/** Pass `null` until the environment is connected, so the probe has a tunnel to use. */
export function useForwardsFrom(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(environmentId === null ? NOT_FORWARDABLE : onOtherMachineAtom(environmentId));
}

export const forwardSourcesAtom = environmentAtomList(
  "desktop:port-forward-sources",
  onOtherMachineAtom,
);

export const findPortForward = (
  forwards: ReadonlyArray<DesktopPortForward>,
  environmentId: EnvironmentId,
  remotePort: number,
) =>
  forwards.find(
    (forward) => forward.environmentId === environmentId && forward.remotePort === remotePort,
  );

export function forwardPort(environmentId: EnvironmentId, remotePort: number) {
  const bridge = previewBridge();
  if (!bridge) return Promise.reject(new Error(m(msg("Port forwarding needs the desktop app."))));
  return bridge.forwardPort(environmentId, remotePort).catch((error: unknown) => {
    // Electron flattens main-process errors into "Error invoking remote method '…': Tag: text".
    const raw = error instanceof Error ? error.message : String(error);
    throw new Error(
      raw.includes("LoopbackTunnelSameMachineError")
        ? m(
            msg("This environment runs on this computer, so localhost:{port} already reaches it.", {
              port: remotePort,
            }),
          )
        : raw.replace(/^Error invoking remote method '[^']*':\s*(\w+Error:\s*)?/u, ""),
      { cause: error },
    );
  });
}

export function stopPortForward(environmentId: EnvironmentId, remotePort: number) {
  return previewBridge()?.stopPortForward(environmentId, remotePort) ?? Promise.resolve();
}

/** `url` with its host and port moved to the forward's end on this machine. */
export function forwardedUrl(forward: DesktopPortForward, url?: string): string {
  const local = new URL(url ?? "http://localhost/");
  local.hostname = "localhost";
  local.port = String(forward.localPort);
  return local.toString();
}
