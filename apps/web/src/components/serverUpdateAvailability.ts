import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../versionSkew";

/**
 * "Update available" is a fact about the server this thread runs on, so the
 * server chip in the composer context strip carries it. Null while the server
 * matches the client, is ahead of it, or has an update in flight (the thread's
 * notice stack carries progress and failure).
 */
export function useServerUpdateAvailability(environmentId: EnvironmentId | null) {
  const environment = useEnvironment(environmentId);
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const mismatch = resolveServerConfigVersionMismatch(environment?.serverConfig);
  if (environmentId === null || !environment || !mismatch || updateState.status !== "idle") {
    return null;
  }
  return {
    environmentId,
    serverLabel: environment.label,
    serverVersion: mismatch.serverVersion,
    targetVersion: mismatch.clientVersion,
    selfUpdate: resolveServerSelfUpdateCapability(environment.serverConfig),
    desktopAppUpdate: supportsDesktopAppUpdate(environment.serverConfig),
    threadContinuation: supportsServerUpdateThreadContinuation(environment.serverConfig),
  };
}

export type ServerUpdateAvailability = NonNullable<ReturnType<typeof useServerUpdateAvailability>>;
