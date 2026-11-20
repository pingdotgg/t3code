import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ProjectEntry,
  sessionGrantsScope,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { failureText } from "../settings/failureText";
import { environmentSession } from "./server";

const listEntries = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:files:list-entries",
  tag: WS_METHODS.projectsListEntries,
});
const writeFile = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:files:write-file",
  tag: WS_METHODS.projectsWriteFile,
});

/** The entries directly inside a directory, which is relative to `cwd`. A failure throws the engine's own reason. */
export async function listFolder(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath: string,
): Promise<ReadonlyArray<ProjectEntry>> {
  const result = await runAtomCommand(
    registry,
    listEntries,
    { environmentId, input: { cwd, directoryPath } },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value.entries;
  throw new Error(failureText(result));
}

/** Writes a file at a path relative to `cwd`. A refusal throws the engine's own reason. */
export async function writeText(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const result = await runAtomCommand(
    registry,
    writeFile,
    { environmentId, input: { cwd, relativePath, contents } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw new Error(failureText(result));
}

/** Whether the connection's session may write files, which T3 reads from the same session state. */
export function useCanWriteFiles(environmentId: EnvironmentId): boolean {
  return useAtomValue(environmentSession.sessionStateAtom(environmentId), (result) => {
    const session = AsyncResult.getOrElse(result, () => null);
    return (
      result._tag !== "Failure" &&
      session !== null &&
      sessionGrantsScope(session, AuthFilesystemWriteScope)
    );
  });
}
