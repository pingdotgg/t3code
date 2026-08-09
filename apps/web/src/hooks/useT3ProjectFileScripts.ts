import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface T3ProjectFileState {
  /**
   * - `valid`: t3.json exists and decoded.
   * - `invalid`: t3.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable t3.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  scripts: ReadonlyArray<T3ProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `t3.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return { status: isPending ? "loading" : "missing", scripts: NO_SCRIPTS } as const;
    }
    const decoded = decodeT3ProjectFile(contents);
    if (Exit.isFailure(decoded)) {
      return { status: "invalid", scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", scripts: decoded.value.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFileState(environmentId, cwd).scripts;
}
