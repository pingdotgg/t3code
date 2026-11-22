import { T3_PROJECT_FILE_NAME, type EnvironmentId, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const T3_PROJECT_FILE_STALE_MS = 30_000;

export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  const query = getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME);
  const current = appAtomRegistry.get(query);
  const needsRefresh =
    !current.waiting &&
    (current._tag === "Failure" ||
      (current._tag === "Success" && Date.now() - current.timestamp >= T3_PROJECT_FILE_STALE_MS));
  const result = await executeAtomQuery(appAtomRegistry, query, {
    refresh: needsRefresh,
    reportDefect: false,
    reportFailure: false,
  });
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}
