import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

import type { MobileThemeAppearance } from "./mobileTheme";

const SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,";
const STYLE_ELEMENT_RE = /<!--[\s\S]*?-->|(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const COLOR_SCHEME_MEDIA_RE = /@media\s*\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)\s*\{/gi;
const AT_RULE_BLOCK_RE = /@[^{};]*\{/g;
const RULE_RE = /([^{}]*)\{([^{}]*)\}/g;
const COLOR_DECLARATION_RE = /(?:^|;)\s*color\s*:\s*([^;]*?)\s*(!\s*important)?\s*(?=;|$)/gi;
const PLAIN_COLOR_RE = /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?)\([\d\s.,%/]+\))$/i;
const COMMENT_OR_SVG_TAG_RE = /<!--[\s\S]*?-->|<svg\b[^>]*>/gi;
const COLOR_ATTRIBUTE_RE = /\s+color\s*=\s*(?:"[^"]*"|'[^']*')/i;
const MEDIA_ATTRIBUTE_RE = /\s+media\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const COLOR_SCHEME_CONDITION_RE = /^\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/i;

// CoreSVG ignores root stylesheet colors and misreads @media; resolve both before decoding.
export function resolveProjectFaviconColorScheme(url: string, scheme: MobileThemeAppearance) {
  if (!url.startsWith(SVG_DATA_URL_PREFIX)) return url;
  const decoded = Base64.decodeString(url.slice(SVG_DATA_URL_PREFIX.length));
  if (Result.isFailure(decoded)) return url;
  const svg = decoded.success;

  let stylesheet = "";
  const styled = svg.replace(
    STYLE_ELEMENT_RE,
    (match, open: string, css: string | undefined, close: string) => {
      if (css === undefined) return match;
      const mediaAttribute = open.match(MEDIA_ATTRIBUTE_RE);
      const media = (mediaAttribute?.[1] ?? mediaAttribute?.[2])?.trim();
      if (media) {
        const condition = media.match(COLOR_SCHEME_CONDITION_RE);
        if (!condition) return match;
        if (condition[1]?.toLowerCase() !== scheme) return "";
        open = open.replace(MEDIA_ATTRIBUTE_RE, "");
      }
      // Comments can hold braces or a commented-out `@media`, which the block matcher would count.
      const resolvedCss = replaceBlocks(
        css.replace(CSS_COMMENT_RE, ""),
        COLOR_SCHEME_MEDIA_RE,
        (match, body) => (match[1]?.toLowerCase() === scheme ? body : ""),
      );
      stylesheet += `${resolvedCss}\n`;
      return `${open}${resolvedCss}${close}`;
    },
  );
  const rootColor = lastRootColor(stylesheet);
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
  let priority = -1;
  const topLevel = replaceBlocks(css, AT_RULE_BLOCK_RE, () => "");
  for (const [, selectors = "", declarations = ""] of topLevel.matchAll(RULE_RE)) {
    const rootSelectors = selectors
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .split(",")
      .map((selector) => selector.trim().toLowerCase());
    const specificity = rootSelectors.includes(":root")
      ? 1
      : rootSelectors.includes("svg")
        ? 0
        : -1;
    if (specificity === -1) continue;
    for (const [, value = "", important] of declarations.matchAll(COLOR_DECLARATION_RE)) {
      const nextPriority = specificity + (important ? 2 : 0);
      if (nextPriority < priority) continue;
      color = PLAIN_COLOR_RE.test(value) ? value : undefined;
      priority = nextPriority;
    }
  }
  return color;
}
