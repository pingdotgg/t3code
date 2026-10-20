import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
} from "@t3tools/contracts";

/**
 * Keep this the one source of truth: the producer (`connection/platform.ts`) mints ids via
 * {@link desktopLocalConnectionId} and every consumer classifies via {@link
 * isDesktopLocalConnectionTarget}, so the convention can never drift between the two.
 */
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

export function isWslConnectionTarget(target: ConnectionTarget): boolean {
  return desktopLocalBackendId(target)?.startsWith("wsl:") === true;
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

export interface DesktopSecondaryBootstrapsReader {
  readonly readResult: () => DesktopSecondaryBootstrapsRead;
  readonly refresh: () => Promise<DesktopSecondaryBootstrapsRead>;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
}

/**
 * A successful empty read is authoritative; a thrown read preserves the previous snapshot so UI
 * consumers cannot temporarily disagree with the platform's retained registrations.
 */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () =>
    | Pick<DesktopBridge, "getLocalEnvironmentBootstraps" | "readLocalEnvironmentBootstraps">
    | undefined,
): DesktopSecondaryBootstrapsReader {
  let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

  const updateSnapshot = (
    entries: ReadonlyArray<DesktopEnvironmentBootstrap>,
  ): DesktopSecondaryBootstrapsRead => {
    const next = entries.filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (
      next.length !== snapshot.length ||
      next.some((entry, index) => {
        const previous = snapshot[index];
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
      snapshot = next;
    }
    return { _tag: "Success", bootstraps: snapshot };
  };

  const readResult = (): DesktopSecondaryBootstrapsRead => {
    const bridge = resolveBridge();
    if (bridge === undefined) {
      if (snapshot.length > 0) snapshot = [];
      return { _tag: "Success", bootstraps: snapshot };
    }
    try {
      return updateSnapshot(bridge.getLocalEnvironmentBootstraps());
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  };

  return {
    readResult,
    refresh: async () => {
      const bridge = resolveBridge();
      if (bridge?.readLocalEnvironmentBootstraps === undefined) return readResult();
      try {
        return updateSnapshot(await bridge.readLocalEnvironmentBootstraps());
      } catch (cause) {
        return { _tag: "Failure", cause };
      }
    },
    readSnapshot: () => {
      const result = readResult();
      return result._tag === "Success" ? result.bootstraps : snapshot;
    },
  };
}

const desktopSecondaryBootstrapsReader = createDesktopSecondaryBootstrapsReader(
  () => window.desktopBridge,
);

export function readDesktopSecondaryBootstrapsResult(): Promise<DesktopSecondaryBootstrapsRead> {
  return desktopSecondaryBootstrapsReader.refresh();
}

export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopSecondaryBootstrapsReader.readSnapshot();
}
