import * as Data from "effect/Data";
import type { PlatformError } from "effect/PlatformError";

export class DockerRegistryBlobUnknown extends Data.TaggedError(
  "DockerRegistryBlobUnknown",
)<{ readonly cause: PlatformError }> {
  override get message() {
    return this.cause.message;
  }
}

export class DockerRegistryUnavailable extends Data.TaggedError(
  "DockerRegistryUnavailable",
)<{ readonly cause: PlatformError }> {
  override get message() {
    return this.cause.message;
  }
}

export type DockerImagePublicationError =
  | PlatformError
  | DockerRegistryBlobUnknown
  | DockerRegistryUnavailable;

export const classifyDockerRegistryError = (
  error: PlatformError,
): DockerImagePublicationError => {
  // Build logs can contain arbitrary Dockerfile output before the final error.
  const message =
    error.reason.description
      ?.split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith(
            "View build details: docker-desktop://dashboard/build/",
          ),
      )
      .at(-1) ?? "";
  if (/(?:^|:\s*)(?:unknown:\s*)?blob unknown to registry$/i.test(message)) {
    return new DockerRegistryBlobUnknown({ cause: error });
  }
  if (
    /(?:unexpected (?:http )?status(?:[^\n]*:\s*|\s+)5\d\d(?:\s|$)|(?:^|:\s*)(?:500 internal server error|502 bad gateway|503 service unavailable|504 gateway timeout)$)/i.test(
      message,
    )
  ) {
    return new DockerRegistryUnavailable({ cause: error });
  }
  return error;
};
