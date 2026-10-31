import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectEnvironment } from "../state/projects";

const COPY_MAX_ENTRIES = 200;
const COPY_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

export async function readProjectFilesToCopy(
  source: { readonly environmentId: EnvironmentId; readonly cwd: string },
  paths: ReadonlyArray<string>,
) {
  const pending = new Set(paths);
  if (pending.size > COPY_MAX_ENTRIES) {
    throw new Error(`Copy at most ${COPY_MAX_ENTRIES} files and folders at a time.`);
  }
  const files = new Set<string>();
  for (const relativePath of pending) {
    if (!relativePath.endsWith("/")) {
      files.add(relativePath);
      continue;
    }
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.listEntries({
        environmentId: source.environmentId,
        input: { cwd: source.cwd, directoryPath: relativePath.slice(0, -1) },
      }),
      { label: "List folder to copy", reportFailure: false, refresh: true },
    );
    if (result._tag === "Failure") throw new Error(failureMessage(result));
    if (result.value.truncated) throw new Error(`Could not list every file in ${relativePath}.`);
    for (const entry of result.value.entries) {
      pending.add(entry.kind === "directory" ? `${entry.path}/` : entry.path);
      if (pending.size > COPY_MAX_ENTRIES) {
        throw new Error(`Copy at most ${COPY_MAX_ENTRIES} files and folders at a time.`);
      }
    }
  }
  const encoder = new TextEncoder();
  let totalBytes = 0;
  const readFile = async (relativePath: string) => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.readFile({
        environmentId: source.environmentId,
        input: { cwd: source.cwd, relativePath },
      }),
      { label: "Read file to copy", reportFailure: false, refresh: true },
    );
    if (result._tag === "Failure") return { relativePath, error: failureMessage(result) };
    totalBytes += encoder.encode(result.value.contents).byteLength;
    if (totalBytes > COPY_MAX_TOTAL_BYTES) {
      throw new Error("Copy at most 20 MB of file contents at a time.");
    }
    if (result.value.truncated) return { relativePath, error: "Too large to copy." };
    return { relativePath, contents: result.value.contents };
  };
  const filePaths = [...files];
  const reads = [];
  for (let offset = 0; offset < filePaths.length; offset += 4) {
    reads.push(...(await Promise.all(filePaths.slice(offset, offset + 4).map(readFile))));
  }
  return reads;
}
