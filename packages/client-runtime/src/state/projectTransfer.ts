import {
  PROJECT_TRANSFER_CHUNK_BYTES,
  type EnvironmentId,
  type ProjectId,
  type ProjectTransferInput,
  type ProjectTransferResult,
  type ProjectTransferMode,
} from "@t3tools/contracts";

export type ProjectTransferRequest = (
  environmentId: EnvironmentId,
  input: ProjectTransferInput,
) => Promise<ProjectTransferResult>;

/** The connected client brokers the bytes; neither server needs the other's credentials or address. */
export async function copyProjectToEnvironment(input: {
  sourceEnvironmentId: EnvironmentId;
  destinationEnvironmentId: EnvironmentId;
  projectId: ProjectId;
  destinationPath: string;
  mode: ProjectTransferMode;
  includeIgnored: boolean;
  request: ProjectTransferRequest;
  signal?: AbortSignal;
  onProgress: (message: string) => void;
}) {
  let sourceTransfer: string | undefined;
  let destinationTransfer: string | undefined;
  const checkCancelled = () => input.signal?.throwIfAborted();
  try {
    checkCancelled();
    input.onProgress(
      input.mode === "copy" ? "Preparing the project snapshot…" : "Reading project settings…",
    );
    const prepared = await input.request(input.sourceEnvironmentId, {
      operation: "prepare",
      projectId: input.projectId,
      mode: input.mode,
      includeIgnored: input.includeIgnored,
    });
    if (prepared.operation !== "prepare") throw new Error("Unexpected snapshot response.");
    sourceTransfer = prepared.transferId;
    checkCancelled();
    const begun = await input.request(input.destinationEnvironmentId, {
      operation: "begin",
      destinationPath: input.destinationPath,
      configuration: prepared.configuration,
      mode: input.mode,
      byteLength: prepared.byteLength,
    });
    if (begun.operation !== "begin") throw new Error("Unexpected destination response.");
    destinationTransfer = begun.transferId;
    for (let offset = 0; offset < prepared.byteLength; offset += PROJECT_TRANSFER_CHUNK_BYTES) {
      checkCancelled();
      const chunk = await input.request(input.sourceEnvironmentId, {
        operation: "read",
        transferId: sourceTransfer,
        offset,
      });
      if (chunk.operation !== "read") throw new Error("Unexpected snapshot chunk.");
      checkCancelled();
      await input.request(input.destinationEnvironmentId, {
        operation: "write",
        transferId: destinationTransfer,
        offset,
        data: chunk.data,
      });
      input.onProgress(
        `Copying files… ${Math.min(100, Math.round(((offset + PROJECT_TRANSFER_CHUNK_BYTES) / prepared.byteLength) * 100))}%`,
      );
    }
    checkCancelled();
    input.onProgress(
      input.mode === "clone"
        ? "Cloning the repository and applying settings…"
        : "Restoring files and applying settings…",
    );
    const result = await input.request(input.destinationEnvironmentId, {
      operation: "finish",
      transferId: destinationTransfer,
    });
    if (result.operation !== "finish") throw new Error("Unexpected project result.");
    return result;
  } finally {
    // Best-effort cleanup must not mask the transfer's original error or its successful result.
    await Promise.allSettled([
      ...(sourceTransfer
        ? [
            input.request(input.sourceEnvironmentId, {
              operation: "release",
              transferId: sourceTransfer,
            }),
          ]
        : []),
      ...(destinationTransfer
        ? [
            input.request(input.destinationEnvironmentId, {
              operation: "release",
              transferId: destinationTransfer,
            }),
          ]
        : []),
    ]);
  }
}
