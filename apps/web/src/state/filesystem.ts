import {
  createFilesystemEnvironmentAtoms,
  resolveFilesystemReadAccess,
} from "@t3tools/client-runtime/state/filesystem";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

export const filesystemMetadata = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:filesystem:get-metadata",
  tag: WS_METHODS.filesystemGetMetadata,
  idleTtlMs: 0,
});

export function useFilesystemReadAccess(environmentId: EnvironmentId | null) {
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const environment = useEnvironmentPresentation(environmentId);
  return resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
}
