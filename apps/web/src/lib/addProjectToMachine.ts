import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  readProjectFilesToCopy,
  writeProjectFilesAfterClone,
} from "@t3tools/client-runtime/state/project-file-copy";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { msg } from "gt-react";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { suggestAppAccessForRemote } from "../components/sourceControlAppAccessToast";
import { silenceProjectCloneToasts } from "../state/projectClones";
import { projectEnvironment } from "../state/projects";
import { sourceControlEnvironment } from "../state/sourceControl";

export interface AddProjectToMachineInput {
  readonly source: { readonly environmentId: EnvironmentId; readonly cwd: string };
  /** Where the source project sits below its repository root, or "". */
  readonly subdirectory: string;
  readonly target: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly projectId: ProjectId;
  readonly title: string;
  readonly remoteUrl: string;
  readonly destinationPath: string;
  readonly files: ReadonlyArray<string>;
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return thrownErrorMessage(error, m) ?? m(msg("An error occurred."));
}

export type ProjectFileCopy =
  | { readonly phase: "copying" }
  | {
      readonly phase: "failed";
      /** A `msg()`, resolved where it is shown so it follows the UI language. */
      readonly title: string;
      readonly failures: ReadonlyArray<string>;
    };

/** Ignored-file copies still owed to a cloned project, keyed by its scoped project key. */
const useFileCopies = create<{ copies: Readonly<Record<string, ProjectFileCopy>> }>(() => ({
  copies: {},
}));

function setFileCopy(key: string, copy: ProjectFileCopy | null) {
  useFileCopies.setState(({ copies }) => {
    const { [key]: _previous, ...rest } = copies;
    return { copies: copy === null ? rest : { ...rest, [key]: copy } };
  });
}

/** The composer holds sends until the copy lands, and shows a failed copy until dismissed. */
export function useProjectFileCopy(ref: ScopedProjectRef | null): ProjectFileCopy | null {
  return useFileCopies((state) => (ref ? (state.copies[scopedProjectKey(ref)] ?? null) : null));
}

export function dismissProjectFileCopy(ref: ScopedProjectRef) {
  setFileCopy(scopedProjectKey(ref), null);
}

/**
 * Clones onto another machine, then relays the chosen ignored files, since the
 * two servers never talk. Resolves with the cloning project once it starts; the
 * caller opens it, and its composer shows progress, so nothing toasts.
 */
export async function addProjectToMachine(input: AddProjectToMachineInput): Promise<ProjectId> {
  const reads = await readProjectFilesToCopy(
    appAtomRegistry,
    projectEnvironment,
    input.source,
    input.files,
    m,
  );

  const requestedRef = { environmentId: input.target.environmentId, projectId: input.projectId };
  const requestedKey = scopedProjectKey(requestedRef);
  // Marked before the start request, since the clone list can arrive before its reply.
  silenceProjectCloneToasts(requestedRef);
  if (reads.length > 0) setFileCopy(requestedKey, { phase: "copying" });
  const started = await runAtomCommand(
    appAtomRegistry,
    sourceControlEnvironment.startProjectClone,
    {
      environmentId: input.target.environmentId,
      input: {
        projectId: input.projectId,
        title: input.title,
        createdAt: new Date().toISOString(),
        remoteUrl: input.remoteUrl,
        destinationPath: input.destinationPath,
      },
    },
    { label: "Add project to machine", reportFailure: false },
  );
  if (started._tag === "Failure") {
    setFileCopy(requestedKey, null);
    throw new Error(failureMessage(started));
  }
  // The server clones for the existing project when one already owns the empty destination.
  const { projectId } = started.value;
  const targetRef = { environmentId: input.target.environmentId, projectId };
  const copyKey = scopedProjectKey(targetRef);
  if (projectId !== input.projectId) {
    silenceProjectCloneToasts(targetRef);
    if (reads.length > 0) {
      setFileCopy(copyKey, { phase: "copying" });
      setFileCopy(requestedKey, null);
    }
  }
  void suggestAppAccessForRemote(input.target.environmentId, input.remoteUrl);
  if (reads.length === 0) return projectId;

  void writeProjectFilesAfterClone(
    appAtomRegistry,
    projectEnvironment,
    {
      clonesAtom: sourceControlEnvironment.projectClones({
        environmentId: input.target.environmentId,
        input: {},
      }),
      sessionGenerationAtom: environmentCatalog.sessionGenerationAtom(input.target.environmentId),
      environmentId: input.target.environmentId,
      projectId,
      cwd: started.value.cwd,
      subdirectory: input.subdirectory,
      reads,
    },
    m,
  ).then((failed) =>
    setFileCopy(
      copyKey,
      failed.length === 0
        ? null
        : {
            phase: "failed",
            title: msg(
              "Could not copy {count, plural, one {{count} file} other {{count} files}} to {target}",
              { count: failed.length, target: input.target.label },
            ),
            failures: failed,
          },
    ),
  );
  return projectId;
}
