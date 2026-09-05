import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
} from "@t3tools/contracts";

/**
 * Desktop-local secondary backends (e.g. a parallel WSL backend) are registered
 * by the connection platform source as bearer connections whose id carries this
 * prefix. It is the renderer's single signal that an environment is a
 * host-managed local backend rather than a user-saved remote, SSH, or relay
 * environment.
 *
 * Keep this the one source of truth: the producer (`connection/platform.ts`)
 * mints ids via {@link desktopLocalConnectionId} and every consumer classifies
 * via {@link isDesktopLocalConnectionTarget}, so the convention can never drift
 * between the two.
 */
export const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function desktopLocalConnectionId(backendId: string): string {
  return `${DESKTOP_LOCAL_CONNECTION_ID_PREFIX}${backendId}`;
}

export function isDesktopLocalConnectionTarget(
  target: ConnectionTarget,
): target is Extract<ConnectionTarget, { readonly _tag: "BearerConnectionTarget" }> {
  return (
    target._tag === "BearerConnectionTarget" &&
    target.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX)
  );
}

export function desktopLocalBackendId(target: ConnectionTarget): string | null {
  return isDesktopLocalConnectionTarget(target)
    ? target.connectionId.slice(DESKTOP_LOCAL_CONNECTION_ID_PREFIX.length)
    : null;
}

export type DesktopSecondaryBootstrapsRead =
  | {
      readonly _tag: "Success";
      readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

/**
 * What the renderer needs from the desktop's local backend list: the secondary
 * backends, and the primary's WSL distro when the primary itself runs inside
 * WSL (wsl-only mode; null in dual mode or before the primary reports a config).
 */
export interface DesktopLocalTopology {
  readonly secondaries: ReadonlyArray<DesktopEnvironmentBootstrap>;
  readonly primaryWslDistro: string | null;
}

const EMPTY_DESKTOP_LOCAL_TOPOLOGY: DesktopLocalTopology = {
  secondaries: [],
  primaryWslDistro: null,
};

export interface DesktopSecondaryBootstrapsReader {
  readonly readResult: () => DesktopSecondaryBootstrapsRead;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
  readonly readTopology: () => DesktopLocalTopology;
}

/**
 * Build a topology reader whose snapshot advances only after successful bridge
 * reads. A successful empty read is authoritative; a thrown read preserves the
 * previous snapshot so UI consumers cannot temporarily disagree with the
 * platform's retained registrations.
 */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () => Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined,
): DesktopSecondaryBootstrapsReader {
  let snapshot: DesktopLocalTopology = EMPTY_DESKTOP_LOCAL_TOPOLOGY;

  const readResult = (): DesktopSecondaryBootstrapsRead => {
    const bridge = resolveBridge();
    if (bridge === undefined) {
      snapshot = EMPTY_DESKTOP_LOCAL_TOPOLOGY;
      return { _tag: "Success", bootstraps: snapshot.secondaries };
    }
    try {
      const bootstraps = bridge.getLocalEnvironmentBootstraps();
      const primary = bootstraps.find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
      snapshot = {
        secondaries: bootstraps.filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID),
        primaryWslDistro: primary?.runningDistro?.trim() || null,
      };
      return { _tag: "Success", bootstraps: snapshot.secondaries };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  };

  return {
    readResult,
    readSnapshot: () => {
      readResult();
      return snapshot.secondaries;
    },
    readTopology: () => {
      readResult();
      return snapshot;
    },
  };
}

const desktopSecondaryBootstrapsReader = createDesktopSecondaryBootstrapsReader(() =>
  typeof window === "undefined" ? undefined : window.desktopBridge,
);

/** Read the topology while preserving failures for platform cache policy. */
export function readDesktopSecondaryBootstrapsResult(): DesktopSecondaryBootstrapsRead {
  return desktopSecondaryBootstrapsReader.readResult();
}

/** Read the latest successful topology snapshot for renderer consumers. */
export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopSecondaryBootstrapsReader.readSnapshot();
}

/** Read the latest successful topology, including the primary's WSL distro. */
export function readDesktopLocalTopology(): DesktopLocalTopology {
  return desktopSecondaryBootstrapsReader.readTopology();
}
