import { useAtomValue } from "@effect/atom-react";
import {
  allowsPreviewTunnel,
  type DesktopPortForward,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

import { tunnelsEnvironmentLoopback } from "../browser/browserTargetResolver";
import { m } from "../i18n/messages";
import { environmentAtomList } from "./environmentAtomList";
import { environmentSession } from "./session";

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

/** Only the desktop app forwards, and only from environments whose tunnel it may use. */
export const canForwardPorts = (environment: {
  readonly entry: { readonly target: ConnectionTarget };
  readonly serverConfig: Parameters<typeof allowsPreviewTunnel>[0] | null;
}): boolean =>
  previewBridge() !== undefined &&
  tunnelsEnvironmentLoopback(environment.entry.target) &&
  environment.serverConfig !== null &&
  allowsPreviewTunnel(environment.serverConfig);

/**
 * Whether the environment runs on another machine. A saved route can still lead back to this
 * computer (its own Tailscale address, a relay), where a forward would only loop.
 */
export type ForwardLocality = "remote" | "local" | "pending" | "unknown";

class PortForwardLocalityError extends Schema.TaggedError<PortForwardLocalityError>()(
  "PortForwardLocalityError",
  { environmentId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return m(msg("Could not tell whether this environment runs on this computer."));
  }
}

// A probe can fail while the environment is briefly unreachable (a reconnect race); retry it.
const LOCALITY_RETRY_SCHEDULE = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

const localityResultAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    // Each established connection probes anew, so a failed probe never outlives a reconnect.
    const connection = AsyncResult.getOrElse(
      get(environmentSession.transportSessionAtom(environmentId)),
      () => Option.none(),
    );
    const bridge = previewBridge();
    if (Option.isNone(connection) || bridge === undefined) return Effect.never;
    return Effect.tryPromise({
      try: () => bridge.sharesLoopback(environmentId),
      catch: (cause) => new PortForwardLocalityError({ environmentId, cause }),
    }).pipe(
      Effect.retry(LOCALITY_RETRY_SCHEDULE),
      Effect.map((shares): ForwardLocality => (shares ? "local" : "remote")),
    );
  }).pipe(
    Atom.setIdleTTL(10 * 60_000),
    Atom.withLabel(`desktop:port-forward-locality-probe:${environmentId}`),
  ),
);

const localityAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ForwardLocality => {
    const result = get(localityResultAtom(environmentId));
    if (AsyncResult.isSuccess(result)) return result.value;
    return AsyncResult.isFailure(result) ? "unknown" : "pending";
  }).pipe(Atom.withLabel(`desktop:port-forward-locality:${environmentId}`)),
);

const NO_LOCALITY = Atom.make<ForwardLocality>("unknown").pipe(
  Atom.withLabel("desktop:port-forward-locality:none"),
);

/** Pass `null` for an environment the desktop doesn't tunnel to; that one never probes. */
export function useForwardLocality(environmentId: EnvironmentId | null): ForwardLocality {
  return useAtomValue(environmentId === null ? NO_LOCALITY : localityAtom(environmentId));
}

export const forwardLocalitiesAtom = environmentAtomList(
  "desktop:port-forward-localities",
  localityAtom,
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
        : raw.includes("LoopbackTunnelUnavailableError")
          ? m(msg("This environment can't be reached right now. Try again once it reconnects."))
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
