import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

import type { MobileThemeAppearance } from "./mobileTheme";

const SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,";
const STYLE_ELEMENT_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const COLOR_SCHEME_MEDIA_RE = /@media\s*\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)\s*\{/gi;
const AT_RULE_BLOCK_RE = /@[^{};]*\{/g;
const RULE_RE = /([^{}]*)\{([^{}]*)\}/g;
const COLOR_DECLARATION_RE = /(?:^|;)\s*color\s*:\s*([^;]*?)\s*(!\s*important)?\s*(?=;|$)/gi;
const PLAIN_COLOR_RE = /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?)\([\d\s.,%/]+\))$/i;
const COMMENT_OR_SVG_TAG_RE = /<!--[\s\S]*?-->|<svg\b[^>]*>/gi;
const COLOR_ATTRIBUTE_RE = /\s+color\s*=\s*(?:"[^"]*"|'[^']*')/i;

/**
 * iOS decodes SVGs with CoreSVG, which doesn't evaluate `@media` (it drops a block's first rule and
 * applies the rest in both schemes) and ignores stylesheet rules on the root element, so an icon
 * that sets its root `color` per color scheme renders `currentColor` as black in both. Resolve
 * those two things for the app's appearance and leave the rest to the decoder.
 */
export function resolveProjectFaviconColorScheme(url: string, scheme: MobileThemeAppearance) {
  if (!url.startsWith(SVG_DATA_URL_PREFIX)) return url;
  const decoded = Base64.decodeString(url.slice(SVG_DATA_URL_PREFIX.length));
  if (Result.isFailure(decoded)) return url;
  const svg = decoded.success;

  let rootColor: string | undefined;
  const styled = svg.replace(
    STYLE_ELEMENT_RE,
    (_match, open: string, css: string, close: string) => {
      const resolvedCss = replaceBlocks(css, COLOR_SCHEME_MEDIA_RE, (match, body) =>
        match[1]?.toLowerCase() === scheme ? body : "",
      );
      rootColor = lastRootColor(resolvedCss) ?? rootColor;
      return `${open}${resolvedCss}${close}`;
    },
  );
  const resolved = rootColor === undefined ? styled : withRootColor(styled, rootColor);
  return resolved === svg ? url : `${SVG_DATA_URL_PREFIX}${Base64.encode(resolved)}`;
}

function withRootColor(svg: string, color: string) {
  let applied = false;
  return svg.replace(COMMENT_OR_SVG_TAG_RE, (match) => {
    if (applied || match.startsWith("<!--")) return match;
    applied = true;
    return `${match.slice(0, 4)} color="${color}"${match.slice(4).replace(COLOR_ATTRIBUTE_RE, "")}`;
  });
}

function replaceBlocks(
  css: string,
  opening: RegExp,
  replace: (match: RegExpExecArray, body: string) => string,
) {
  let result = "";
  let cursor = 0;
  for (const match of css.matchAll(opening)) {
    if (match.index < cursor) continue;
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matchingBrace(css, bodyStart);
    if (bodyEnd === -1) break;
    result += css.slice(cursor, match.index) + replace(match, css.slice(bodyStart, bodyEnd));
    cursor = bodyEnd + 1;
  }
  return result + css.slice(cursor);
}

function matchingBrace(css: string, from: number) {
  let depth = 1;
  for (let index = from; index < css.length; index++) {
    if (css[index] === "{") depth++;
    else if (css[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function lastRootColor(css: string) {
  let color: string | undefined;
  let colorIsImportant = false;
  const topLevel = replaceBlocks(css, AT_RULE_BLOCK_RE, () => "");
  for (const [, selectors = "", declarations = ""] of topLevel.matchAll(RULE_RE)) {
    const targetsRoot = selectors
      .replace(/<!\[CDATA\[|\]\]>|\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .some((selector) => /^(?::root|svg)$/i.test(selector.trim()));
    if (!targetsRoot) continue;
    for (const [, value = "", important] of declarations.matchAll(COLOR_DECLARATION_RE)) {
      if (!PLAIN_COLOR_RE.test(value) || (colorIsImportant && !important)) continue;
      color = value;
      colorIsImportant = important !== undefined;
    }
  }
  return color;
}
