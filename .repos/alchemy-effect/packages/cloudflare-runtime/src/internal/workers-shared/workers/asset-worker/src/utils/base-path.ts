// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Asset-worker-local helpers for converting between public request pathnames
 * and asset-directory-relative pathnames using the configured `base_path`.
 *
 * `base` is always the canonical stored form: either `"/"` or an absolute
 * pathname with a trailing slash such as `"/subpath/"`.
 */

/**
 * Segment-aware check that a decoded public path is at, or nested under, the
 * base. `/subpath` matches `/subpath` and `/subpath/...`, but not
 * `/subpath-other`. The root base `"/"` matches everything.
 */
function isWithinBase(publicDecodedPath: string, base: string): boolean {
  if (base === "/") {
    return true;
  }
  return publicDecodedPath === base.slice(0, -1) || publicDecodedPath.startsWith(base);
}

/**
 * Strip the configured base from a decoded public pathname, returning the
 * asset-directory-relative path.
 *
 * - When `base` is `"/"` this is the identity mapping (`inPrefix: true`).
 * - The base root itself maps to `assetPath: "/"`.
 * - A leading `/` is always preserved on the returned asset path.
 * - When the path is off-prefix, `inPrefix` is `false` and the caller returns
 *   `NoIntentResponse`.
 */
export function stripBasePath(
  publicDecodedPath: string,
  base: string,
): { inPrefix: boolean; assetPath: string } {
  if (base === "/") {
    return { inPrefix: true, assetPath: publicDecodedPath };
  }

  if (!isWithinBase(publicDecodedPath, base)) {
    return { inPrefix: false, assetPath: publicDecodedPath };
  }

  const stripped = publicDecodedPath.slice(base.length - 1);
  return { inPrefix: true, assetPath: stripped === "" ? "/" : stripped };
}

/**
 * Re-append the configured base to an asset-directory-relative location,
 * producing a public path. Only ever call this with an explicitly
 * asset-relative location (e.g. an asset-worker-generated redirect); never with
 * a value that might already be public. The empty string represents the base
 * root without its canonical trailing slash.
 */
export function addBasePath(assetRelativePath: string, base: string): string {
  if (base === "/") {
    return assetRelativePath;
  }
  if (assetRelativePath === "/") {
    return base;
  }
  return base.slice(0, -1) + assetRelativePath;
}
