import {
  LATHE_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type LatheProjectFile,
} from "@lathe/contracts";
import { parseLatheProjectFile } from "@lathe/shared/latheProjectFile";
import { executeAtomQuery } from "@lathe/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

function toLatheProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  result: ProjectReadFileResult | null,
): LatheProjectFile | null {
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    LATHE_PROJECT_FILE_NAME,
    result,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseLatheProjectFile(data.contents);
}

export async function readLatheProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<LatheProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, LATHE_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  return toLatheProjectFile(
    environmentId,
    workspaceRoot,
    result._tag === "Success" ? result.value : null,
  );
}

/** The project's lathe.json from an earlier read, or `undefined` when none has loaded yet. */
export function peekLatheProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): LatheProjectFile | null | undefined {
  const result = appAtomRegistry.get(
    getProjectFileQueryAtom(environmentId, workspaceRoot, LATHE_PROJECT_FILE_NAME),
  );
  return AsyncResult.isSuccess(result)
    ? toLatheProjectFile(environmentId, workspaceRoot, result.value)
    : undefined;
}
