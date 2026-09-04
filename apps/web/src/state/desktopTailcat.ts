import type {
  DesktopBridge,
  DesktopTailcatEnvironmentBootstrap,
  TailcatConnectionDiagnostics,
  TailcatRuntimeAvailability,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const DESKTOP_TAILCAT_RUNTIME_STALE_TIME_MS = 30_000;
const DESKTOP_TAILCAT_DIAGNOSTICS_STALE_TIME_MS = 5_000;
const DESKTOP_TAILCAT_DIAGNOSTICS_IDLE_TTL_MS = 60_000;

/**
 * The optional Tailcat surface of the desktop bridge. Older desktop shells and
 * browsers have none of these, so every accessor is nullable and callers show
 * "desktop app required" instead of a broken control.
 */
export type DesktopTailcatBridge = Pick<
  DesktopBridge,
  | "ensureTailcatEnvironment"
  | "getTailcatRuntimeAvailability"
  | "getTailcatConnectionDiagnostics"
  | "probeTailcatConnectionPath"
  | "restartTailcatEnvironment"
>;

export class DesktopTailcatUnavailableError extends Schema.TaggedErrorClass<DesktopTailcatUnavailableError>()(
  "DesktopTailcatUnavailableError",
  {},
) {
  override get message(): string {
    return "Tailcat tunnels are managed by the T3 Code desktop app.";
  }
}

export class DesktopTailcatBridgeError extends Schema.TaggedErrorClass<DesktopTailcatBridgeError>()(
  "DesktopTailcatBridgeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Tailcat ${this.operation} failed: ${detail}`;
  }
}

function getDesktopTailcatBridge(): DesktopTailcatBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

/** True when this renderer can start Tailcat tunnels (desktop app with a Tailcat-aware bridge). */
export function isDesktopTailcatAvailable(
  bridge: DesktopTailcatBridge | undefined = getDesktopTailcatBridge(),
): boolean {
  return bridge?.ensureTailcatEnvironment !== undefined;
}

export function createDesktopTailcatRuntimeAvailabilityAtom(
  getBridge: () => DesktopTailcatBridge | undefined,
) {
  const loadRuntimeAvailability = Effect.fn("loadDesktopTailcatRuntimeAvailability")(function* () {
    const bridge = getBridge();
    const getTailcatRuntimeAvailability = bridge?.getTailcatRuntimeAvailability;
    if (bridge === undefined || getTailcatRuntimeAvailability === undefined) {
      return yield* new DesktopTailcatUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<TailcatRuntimeAvailability> => getTailcatRuntimeAvailability.call(bridge),
      catch: (cause) => new DesktopTailcatBridgeError({ operation: "runtime check", cause }),
    });
  });

  return Atom.make(loadRuntimeAvailability()).pipe(
    Atom.swr({ staleTime: DESKTOP_TAILCAT_RUNTIME_STALE_TIME_MS, revalidateOnMount: true }),
    Atom.keepAlive,
    Atom.withLabel("desktop:tailcat-runtime-availability"),
  );
}

export const desktopTailcatRuntimeAvailabilityAtom =
  createDesktopTailcatRuntimeAvailabilityAtom(getDesktopTailcatBridge);

/**
 * Transport diagnostics for one saved Tailcat environment, keyed by its
 * connection id. Null while the desktop has no forwarder for that id.
 */
export function createDesktopTailcatDiagnosticsAtomFamily(
  getBridge: () => DesktopTailcatBridge | undefined,
) {
  const loadDiagnostics = Effect.fn("loadDesktopTailcatDiagnostics")(function* (
    connectionId: string,
  ) {
    const bridge = getBridge();
    const getTailcatConnectionDiagnostics = bridge?.getTailcatConnectionDiagnostics;
    if (bridge === undefined || getTailcatConnectionDiagnostics === undefined) {
      return yield* new DesktopTailcatUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<TailcatConnectionDiagnostics | null> =>
        getTailcatConnectionDiagnostics.call(bridge, connectionId),
      catch: (cause) => new DesktopTailcatBridgeError({ operation: "diagnostics", cause }),
    });
  });

  return Atom.family((connectionId: string) =>
    Atom.make(loadDiagnostics(connectionId)).pipe(
      Atom.swr({
        staleTime: DESKTOP_TAILCAT_DIAGNOSTICS_STALE_TIME_MS,
        revalidateOnMount: true,
      }),
      Atom.setIdleTTL(DESKTOP_TAILCAT_DIAGNOSTICS_IDLE_TTL_MS),
      Atom.withLabel(`desktop:tailcat-diagnostics:${connectionId}`),
    ),
  );
}

export const desktopTailcatDiagnosticsAtom =
  createDesktopTailcatDiagnosticsAtomFamily(getDesktopTailcatBridge);

export function refreshDesktopTailcatDiagnostics(connectionId: string): void {
  appAtomRegistry.refresh(desktopTailcatDiagnosticsAtom(connectionId));
}

function requireDesktopTailcatBridge(): DesktopTailcatBridge {
  const bridge = getDesktopTailcatBridge();
  if (bridge === undefined || !isDesktopTailcatAvailable(bridge)) {
    throw new DesktopTailcatUnavailableError();
  }
  return bridge;
}

/** Measures the current path (direct or DERP relay) and refreshes the diagnostics view. */
export async function probeDesktopTailcatConnectionPath(
  connectionId: string,
): Promise<TailcatConnectionDiagnostics | null> {
  const bridge = requireDesktopTailcatBridge();
  const probeTailcatConnectionPath = bridge.probeTailcatConnectionPath;
  if (probeTailcatConnectionPath === undefined) {
    throw new DesktopTailcatUnavailableError();
  }
  try {
    return await probeTailcatConnectionPath.call(bridge, connectionId);
  } finally {
    refreshDesktopTailcatDiagnostics(connectionId);
  }
}

/** Restarts the forwarder for a saved environment and refreshes the diagnostics view. */
export async function restartDesktopTailcatEnvironment(
  connectionId: string,
): Promise<DesktopTailcatEnvironmentBootstrap> {
  const bridge = requireDesktopTailcatBridge();
  const restartTailcatEnvironment = bridge.restartTailcatEnvironment;
  if (restartTailcatEnvironment === undefined) {
    throw new DesktopTailcatUnavailableError();
  }
  try {
    return await restartTailcatEnvironment.call(bridge, connectionId);
  } finally {
    refreshDesktopTailcatDiagnostics(connectionId);
  }
}
