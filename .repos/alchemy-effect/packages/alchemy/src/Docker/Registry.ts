import type * as Redacted from "effect/Redacted";

export interface ImageRegistry {
  /** Registry host, e.g. `ghcr.io`. */
  server: string;
  /** Registry username. */
  username: string;
  /** Registry password. Use `Redacted.make(...)` or `Config.redacted(...)`. */
  password: Redacted.Redacted<string>;
}

/** Strips the tag and digest from an image reference, leaving the repository. */
export const repositoryFromImageRef = (imageRef: string): string => {
  const withoutDigest = imageRef.includes("@")
    ? imageRef.slice(0, imageRef.indexOf("@"))
    : imageRef;
  const tagSeparator = withoutDigest.lastIndexOf(":");
  const pathSeparator = withoutDigest.lastIndexOf("/");
  return tagSeparator > pathSeparator
    ? withoutDigest.slice(0, tagSeparator)
    : withoutDigest;
};

/**
 * Prefixes an image reference with the registry host unless the reference
 * already carries a registry prefix (a dotted host, a host:port, or `localhost`).
 */
export const withRegistryHost = (
  imageRef: string,
  registry: { server: string },
): string => {
  const registryHost = registry.server.replace(/\/$/, "");
  const firstSegment = imageRef.split("/")[0];
  const hasRegistryPrefix =
    imageRef.includes("/") &&
    (firstSegment.includes(".") ||
      firstSegment.includes(":") ||
      firstSegment === "localhost");
  return hasRegistryPrefix ? imageRef : `${registryHost}/${imageRef}`;
};

/** Extracts the `repository@sha256:...` digest from `docker push` output. */
export const parseRepoDigest = (
  imageRef: string,
  output: string,
): string | undefined => {
  const match = /digest:\s+([a-z0-9]+:[a-f0-9]{64})/i.exec(output);
  if (!match) return undefined;
  return `${repositoryFromImageRef(imageRef)}@${match[1]}`;
};

/**
 * Parses an image's RFC 3339 `Created` timestamp into epoch milliseconds.
 *
 * Docker only reports `Created` when the image config carries a creation time:
 * API >= 1.44 omits it, older APIs backfill the year-1 zero value
 * (`0001-01-01T00:00:00Z`), and 25.0.0–25.0.3 returned an empty string. In any
 * of those cases there is no real build time, so we fall back to the wall clock.
 */
export const parseCreatedAt = (created: string | undefined): number => {
  const parsed = created ? Date.parse(created) : Number.NaN;
  return Number.isNaN(parsed) || parsed <= 0 ? Date.now() : parsed;
};
