import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const PACKAGE_JSON_PATH = "package.json";
const COMPOSER_JSON_PATH = "composer.json";

export type DetectedProjectScriptSource = "npm" | "composer";

export interface DetectedProjectScript {
  readonly name: string;
  readonly command: string;
  readonly source: DetectedProjectScriptSource;
}

const NO_SCRIPTS: ReadonlyArray<DetectedProjectScript> = [];

function scriptNamesFromJson(contents: string): ReadonlyArray<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return [];
  return Object.keys(scripts);
}

/** Scripts declared in `package.json`, runnable as `npm run <name>`. */
export function detectedScriptsFromPackageJson(
  contents: string,
): ReadonlyArray<DetectedProjectScript> {
  return scriptNamesFromJson(contents).map((name) => ({
    name,
    command: `npm run ${name}`,
    source: "npm" as const,
  }));
}

/** Scripts declared in `composer.json`, runnable as `composer run-script <name>`. */
export function detectedScriptsFromComposerJson(
  contents: string,
): ReadonlyArray<DetectedProjectScript> {
  return scriptNamesFromJson(contents).map((name) => ({
    name,
    command: `composer run-script ${name}`,
    source: "composer" as const,
  }));
}

/**
 * Scripts declared in the project's `package.json` and `composer.json`,
 * offered in the Add Action menu so they can be imported without retyping
 * the run command. Missing, truncated, or invalid files resolve to an empty
 * list for that source.
 */
export function usePackageManagerScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<DetectedProjectScript> {
  const npmQuery = useProjectFileQuery(environmentId, cwd ?? "", PACKAGE_JSON_PATH, cwd !== null);
  const composerQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    COMPOSER_JSON_PATH,
    cwd !== null,
  );
  const npmContents = npmQuery.data && !npmQuery.data.truncated ? npmQuery.data.contents : null;
  const composerContents =
    composerQuery.data && !composerQuery.data.truncated ? composerQuery.data.contents : null;

  return useMemo(() => {
    const combined = [
      ...(npmContents === null ? [] : detectedScriptsFromPackageJson(npmContents)),
      ...(composerContents === null ? [] : detectedScriptsFromComposerJson(composerContents)),
    ];
    return combined.length > 0 ? combined : NO_SCRIPTS;
  }, [npmContents, composerContents]);
}
