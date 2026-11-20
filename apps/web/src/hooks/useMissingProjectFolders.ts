import { useAtomValue } from "@effect/atom-react";
import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import { isNetworkPath } from "@t3tools/shared/path";
import { Atom } from "effect/reactivity";

import { projectEnvironment } from "../state/projects";
import { useEnvironmentsWithScope } from "../state/session";

interface ProjectFolder {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

const NO_FOLDERS: ReadonlyArray<string> = [];

const missingFoldersAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const folders = JSON.parse(key) as ReadonlyArray<readonly [EnvironmentId, string]>;
    const missing = folders.flatMap(([environmentId, path]) => {
      const result = get(projectEnvironment.fileMetadata({ environmentId, input: { path } }));
      // Only a settled answer counts: a folder is not missing while its machine is unreachable.
      return result._tag === "Success" && result.value?.kind !== "directory" ? [path] : [];
    });
    return missing.length === 0 ? NO_FOLDERS : missing;
  }).pipe(Atom.withLabel(`missing-project-folders:${key}`)),
);

/**
 * The folders among these projects that are gone from disk. The checks ride the batched file
 * metadata request, so a sidebar of projects costs one request per environment.
 */
export function useMissingProjectFolders(
  projects: ReadonlyArray<ProjectFolder>,
): ReadonlyArray<string> {
  const readable = useEnvironmentsWithScope(projects, AuthFilesystemReadScope);
  return useAtomValue(
    missingFoldersAtom(
      JSON.stringify(
        projects.flatMap(({ environmentId, workspaceRoot }) =>
          // The server never stats a network path, so its answer says nothing about one.
          readable.has(environmentId) && !isNetworkPath(workspaceRoot)
            ? [[environmentId, workspaceRoot]]
            : [],
        ),
      ),
    ),
  );
}
