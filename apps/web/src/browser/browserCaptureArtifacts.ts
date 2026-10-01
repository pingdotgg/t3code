/**
 * Browser capture artifacts live in the environment's attachment store as
 * pending image uploads. The artifactRef handed to extensions is the pending
 * attachment id, so every hop after the capture moves a ref, not bytes.
 */
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";
import { attachmentEnvironment } from "~/state/attachments";
import { readPreparedConnection } from "~/state/session";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when the bytes open with the PNG signature. */
function isPngBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  );
}

/** Uploads one PNG capture and returns its pending attachment id. */
export async function uploadBrowserCapture(
  environmentId: EnvironmentId,
  png: Blob,
  name: string,
): Promise<string> {
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: { type: "image", name, mimeType: "image/png", sizeBytes: png.size },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => {
      const controller = new AbortController();
      return {
        abort: () => controller.abort(),
        done: fetch(url, {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: png,
          signal: controller.signal,
        }).then((response) => {
          if (!response.ok) throw new Error(`Capture upload rejected (${response.status}).`);
        }),
      };
    },
  });
  if (result.status === "uploaded") return result.attachmentId;
  if (result.attachmentId) {
    deletePendingAttachmentUpload({
      registry: appAtomRegistry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId: result.attachmentId,
    });
  }
  const cause = result.status === "failed" ? result.error : null;
  throw cause instanceof Error ? cause : new Error("The capture upload did not finish.");
}

/**
 * Deletes a capture's pending upload once a draft holds its own copy of the
 * bytes. Best effort: a failed delete leaves the upload to the store's sweep.
 */
export function releaseBrowserCaptureArtifact(
  environmentId: EnvironmentId,
  artifactRef: string,
): void {
  deletePendingAttachmentUpload({
    registry: appAtomRegistry,
    remove: attachmentEnvironment.remove,
    environmentId,
    attachmentId: artifactRef,
  });
}

/**
 * Reads a capture back out of the store as a PNG File, for the client that
 * hosts the draft. Refuses anything that is not a PNG within the image limit,
 * so a stray pending upload cannot pose as a capture.
 */
export async function fetchBrowserCaptureArtifact(
  environmentId: EnvironmentId,
  artifactRef: string,
  name: string,
): Promise<File> {
  const minted = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: {
        resource: {
          _tag: "attachment",
          attachmentId: artifactRef,
          fileName: name,
          mimeType: "image/png",
          disposition: "inline",
        },
      },
    }),
    { reportFailure: false, reportDefect: false, refresh: true },
  );
  if (minted._tag !== "Success") {
    const error = squashAtomCommandFailure(minted);
    throw error instanceof Error ? error : new Error("The capture is no longer available.");
  }
  const connection = readPreparedConnection(environmentId);
  const url = connection ? resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl) : null;
  if (!url) throw new Error("The environment is not connected.");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The capture could not be read (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
    throw new Error("The capture exceeds the image attachment limit.");
  if (!isPngBytes(bytes)) throw new Error("The artifact is not a PNG capture.");
  return new File([bytes], name, { type: "image/png" });
}
