import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
} from "@t3tools/contracts";

const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

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

export type DesktopBootstrapsRead =
  | {
      readonly _tag: "Success";
      readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export type DesktopSecondaryBootstrapsRead = DesktopBootstrapsRead;

export interface DesktopSecondaryBootstrapsReader {
  readonly readResult: () => DesktopSecondaryBootstrapsRead;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
  readonly readAllResult: () => DesktopBootstrapsRead;
  readonly readAllSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
}

/** Empty reads clear the snapshot; failed reads retain platform registrations. */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () => Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined,
): DesktopSecondaryBootstrapsReader {
  let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];
  let allSnapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

  const readAllResult = (): DesktopBootstrapsRead => {
    const bridge = resolveBridge();
    if (bridge === undefined) {
      if (allSnapshot.length > 0) allSnapshot = [];
      if (snapshot.length > 0) snapshot = [];
      return { _tag: "Success", bootstraps: allSnapshot };
    }
    try {
      const next = bridge.getLocalEnvironmentBootstraps();
      if (
        next.length !== allSnapshot.length ||
        next.some((entry, index) => {
          const previous = allSnapshot[index];
          return (
            previous === undefined ||
            entry.id !== previous.id ||
            entry.label !== previous.label ||
            entry.runningDistro !== previous.runningDistro ||
            entry.httpBaseUrl !== previous.httpBaseUrl ||
            entry.wsBaseUrl !== previous.wsBaseUrl ||
            entry.bootstrapToken !== previous.bootstrapToken
          );
        })
      ) {
        allSnapshot = next;
      }
      const nextSecondary = allSnapshot.filter(
        (entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID,
      );
      if (
        nextSecondary.length !== snapshot.length ||
        nextSecondary.some((entry, index) => entry !== snapshot[index])
      ) {
        snapshot = nextSecondary;
      }
      return { _tag: "Success", bootstraps: allSnapshot };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  };

  const readResult = (): DesktopSecondaryBootstrapsRead => {
    const result = readAllResult();
    return result._tag === "Success" ? { _tag: "Success", bootstraps: snapshot } : result;
  };

  return {
    readResult,
    readAllResult,
    readSnapshot: () => {
      const result = readResult();
      return result._tag === "Success" ? result.bootstraps : snapshot;
    },
    readAllSnapshot: () => {
      const result = readAllResult();
      return result._tag === "Success" ? result.bootstraps : allSnapshot;
    },
  };
}

const desktopBootstrapsReader = createDesktopSecondaryBootstrapsReader(() => window.desktopBridge);

export function readDesktopSecondaryBootstrapsResult(): DesktopSecondaryBootstrapsRead {
  return desktopBootstrapsReader.readResult();
}

export function readDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopBootstrapsReader.readAllSnapshot();
}
