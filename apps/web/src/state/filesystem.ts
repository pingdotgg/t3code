import {
  createFilesystemEnvironmentAtoms,
  resolveFilesystemReadAccess,
} from "@lathe/client-runtime/state/filesystem";
import type { EnvironmentId } from "@lathe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { m, type MessageResolver } from "../i18n/messages";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

export function useFilesystemReadAccess(
  environmentId: EnvironmentId | null,
  resolve: MessageResolver = m,
) {
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
    resolve,
  );
  const environment = useEnvironmentPresentation(environmentId);
  return resolveFilesystemReadAccess(
    {
      isCatalogReady: environment.isReady,
      connection: environment.presentation?.connection ?? null,
      session: session.data,
      sessionError: session.error,
    },
    resolve,
  );
}
