// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Canonical normalization for the `assets.base_path` configuration field.
 *
 * This implements the shared canonical path contract applied by the Asset
 * Worker when it receives its final configuration.
 *
 * The stored canonical form is either the root `"/"` or an absolute pathname
 * with both leading and trailing slashes, such as `"/subpath/"`.
 */

export type BasePathValidationResult =
  | { valid: true; value: string }
  | { valid: false; error: string };

// eslint-disable-next-line no-control-regex -- control characters are matched intentionally so they can be rejected in `base_path`
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Validate and normalize a raw `base_path` value into its canonical stored form.
 *
 * Relative and absolute pathname inputs are accepted and interpreted as a fixed
 * root-relative request prefix. Empty and dot segments are resolved before a
 * leading and trailing slash are applied. URL-shaped values, query or fragment
 * delimiters, backslashes, control characters, and percent-encoded sequences
 * are rejected. Unicode pathname characters are allowed.
 */
export function normalizeBasePath(value: unknown): BasePathValidationResult {
  if (value === "/") {
    return { valid: true, value: "/" };
  }

  if (typeof value !== "string") {
    return {
      valid: false,
      error: `Expected a string but got ${typeof value}.`,
    };
  }

  if (value.length === 0) {
    return { valid: false, error: `The value must not be empty.` };
  }

  if (value.startsWith("//") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
    return {
      valid: false,
      error: `The value must be a pathname, not a URL.`,
    };
  }

  if (value.includes("\\")) {
    return { valid: false, error: `The value must not contain backslashes.` };
  }

  if (CONTROL_CHARACTER.test(value)) {
    return {
      valid: false,
      error: `The value must not contain control characters.`,
    };
  }

  if (value.includes("?") || value.includes("#")) {
    return {
      valid: false,
      error: `The value must not contain query strings or fragments.`,
    };
  }

  if (value.includes("%")) {
    return {
      valid: false,
      error: `The value must not contain percent-encoded sequences.`,
    };
  }

  const normalizedSegments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }

  const canonical = normalizedSegments.length === 0 ? "/" : `/${normalizedSegments.join("/")}/`;
  return { valid: true, value: canonical };
}

/**
 * Decode and normalize a URI-encoded `base_path` without decoding reserved URI
 * delimiters. In particular, `decodeURI` leaves encoded path separators such
 * as `%2F` intact so that `normalizeBasePath` rejects them as ambiguous.
 */
export function normalizeUriEncodedBasePath(value: unknown): BasePathValidationResult {
  if (typeof value !== "string") {
    return normalizeBasePath(value);
  }

  try {
    return normalizeBasePath(decodeURI(value));
  } catch {
    return {
      valid: false,
      error: `The value contains malformed URI encoding.`,
    };
  }
}
