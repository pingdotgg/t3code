import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export type T3ProjectFileStatus = "disabled" | "loading" | "ready" | "invalid" | "unavailable";

export interface T3ProjectFileState {
  readonly status: T3ProjectFileStatus;
  readonly file: T3ProjectFile | null;
  readonly scripts: ReadonlyArray<T3ProjectFileScript>;
  readonly error: string | null;
}

export function resolveT3ProjectFileState(input: {
  readonly enabled: boolean;
  readonly data: ProjectReadFileResult | null;
  readonly error: string | null;
}): T3ProjectFileState {
  if (!input.enabled) {
    return { status: "disabled", file: null, scripts: NO_SCRIPTS, error: null };
  }
  if (input.data === null) {
    if (input.error !== null) {
      return {
        status: "unavailable",
        file: null,
        scripts: NO_SCRIPTS,
        error: input.error,
      };
    }
    return { status: "loading", file: null, scripts: NO_SCRIPTS, error: null };
  }
  if (input.data.truncated) {
    return {
      status: "invalid",
      file: null,
      scripts: NO_SCRIPTS,
      error: `${T3_PROJECT_FILE_NAME} is too large to read safely.`,
    };
  }

  const decoded = decodeT3ProjectFile(input.data.contents);
  if (Exit.isFailure(decoded)) {
    return {
      status: "invalid",
      file: null,
      scripts: NO_SCRIPTS,
      error: `${T3_PROJECT_FILE_NAME} does not match the project-file schema.`,
    };
  }
  return {
    status: "ready",
    file: decoded.value,
    scripts: decoded.value.scripts ?? NO_SCRIPTS,
    error: null,
  };
}

export function useT3ProjectFile(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  const enabled = cwd !== null;
  const query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, enabled);
  return useMemo(
    () =>
      resolveT3ProjectFileState({
        enabled,
        data: query.data,
        error: query.error,
      }),
    [enabled, query.data, query.error],
  );
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
  return useT3ProjectFile(environmentId, cwd).scripts;
}
