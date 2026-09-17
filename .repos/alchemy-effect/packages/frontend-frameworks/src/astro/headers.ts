// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.1.3 (`src/utils/headers.ts`).
 *
 * Build-side `_headers` synthesis: injects an immutable `Cache-Control`
 * rule for Astro's content-hashed assets directory (`_astro/` by default)
 * unless the user's existing `_headers` file already sets (or detaches)
 * `Cache-Control` on a rule matching that path.
 */

/**
 * Convert a Cloudflare `_headers` URL pattern to a RegExp.
 *
 * Supports `*` (matches any sequence, including `/`) and `:placeholder`
 * segments (match one path segment). Everything else is literal.
 */
function cfHeadersPatternToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      regexStr += ".*";
      i++;
    } else if (ch === ":" && /[A-Za-z]/.test(pattern[i + 1] ?? "")) {
      i++;
      while (i < pattern.length && /\w/.test(pattern[i]!)) i++;
      regexStr += "[^/]+";
    } else {
      regexStr += ch!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`);
}

/**
 * Whether an existing `_headers` file already sets (or explicitly detaches)
 * `Cache-Control` on a rule matching `path`.
 */
export function headersFileHasCacheControlForPath(
  content: string,
  path: string,
): boolean {
  let matchesCurrentSection = false;
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const isSectionHeader = !/^\s/.test(rawLine);
    if (isSectionHeader) {
      const pathOnly = trimmed.replace(/^https?:\/\/[^/]+/, "");
      try {
        matchesCurrentSection = cfHeadersPatternToRegex(pathOnly).test(path);
      } catch {
        matchesCurrentSection = false;
      }
    } else if (
      matchesCurrentSection &&
      // Either `Cache-Control: value` (set) or `! Cache-Control` (detach).
      /^\s+(?:!\s+cache-control\s*$|cache-control\s*:)/i.test(rawLine)
    ) {
      return true;
    }
  }
  return false;
}

export interface BuildAssetsHeadersOptions {
  /** Astro's hashed-assets directory name (`config.build.assets`, default `_astro`). */
  readonly assetsDir: string;
  /** The site base without its trailing slash (empty string for `/`). */
  readonly basePrefix: string;
  /** Path (or URL) of the `_headers` file, passed to `readFile`. */
  readonly headersPath: string | URL;
}

/**
 * Compute the new `_headers` content with the immutable `Cache-Control`
 * block for the hashed-assets directory prepended. Returns `null` when the
 * existing file already covers the assets path (nothing to do).
 */
export async function buildAssetsHeadersContent(
  opts: BuildAssetsHeadersOptions,
  readFile: (path: string | URL) => Promise<string>,
): Promise<{ content: string; assetsPattern: string } | null> {
  const { assetsDir, basePrefix, headersPath } = opts;
  const assetsPattern = `${basePrefix}/${assetsDir}/*`;
  const probePath = `${basePrefix}/${assetsDir}/probe`;

  let existingHeaders = "";
  try {
    existingHeaders = await readFile(headersPath);
  } catch {
    // No existing _headers file.
  }

  if (headersFileHasCacheControlForPath(existingHeaders, probePath)) {
    return null;
  }

  const cacheBlock = `${assetsPattern}\n  Cache-Control: public, max-age=31536000, immutable\n`;
  const normalizedExisting =
    existingHeaders && !existingHeaders.endsWith("\n")
      ? existingHeaders + "\n"
      : existingHeaders;
  const content = normalizedExisting
    ? `${cacheBlock}\n${normalizedExisting}`
    : cacheBlock;
  return { content, assetsPattern };
}
