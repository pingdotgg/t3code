// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import {
  MAX_DYNAMIC_REDIRECT_RULES,
  MAX_LINE_LENGTH,
  MAX_STATIC_REDIRECT_RULES,
  PERMITTED_STATUS_CODES,
  PLACEHOLDER_REGEX,
  SPLAT_REGEX,
} from "./constants.ts";
import { urlHasHost, validateUrl } from "./validateURL.ts";
import type { AssetConfig } from "../types.ts";
import type {
  InvalidRedirectRule,
  ParsedRedirects,
  RedirectLine,
  RedirectRule,
} from "./types.ts";

export function parseRedirects(
  input: string,
  {
    htmlHandling = undefined,
    maxStaticRules = MAX_STATIC_REDIRECT_RULES,
    maxDynamicRules = MAX_DYNAMIC_REDIRECT_RULES,
    maxLineLength = MAX_LINE_LENGTH,
  }: {
    htmlHandling?: AssetConfig["html_handling"];
    maxStaticRules?: number;
    maxDynamicRules?: number;
    maxLineLength?: number;
  } = {},
): ParsedRedirects {
  const lines = input.split("\n");
  const rules: Array<RedirectRule> = [];
  const seen_paths = new Set<string>();
  const invalid: Array<InvalidRedirectRule> = [];

  let staticRules = 0;
  let dynamicRules = 0;
  let canCreateStaticRule = true;

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || "").trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (line.length > maxLineLength) {
      invalid.push({
        message: `Ignoring line ${
          i + 1
        } as it exceeds the maximum allowed length of ${maxLineLength}.`,
      });
      continue;
    }

    // Handle inline comments: strip off from the first `#` token that starts a comment, but not URL fragments.
    // This allows `/a /b#fragment` but strips `/a /b # comment`
    const tokens = line.replace(/\s+#.*$/, "").split(/\s+/);

    if (tokens.length < 2 || tokens.length > 3) {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: `Expected exactly 2 or 3 whitespace-separated tokens. Got ${tokens.length}.`,
      });
      continue;
    }

    const [str_from, str_to, str_status = "302"] = tokens as RedirectLine;

    const fromResult = validateUrl(str_from, true, true, false, false);
    if (fromResult[0] === undefined) {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: fromResult[1],
      });
      continue;
    }
    const from = fromResult[0];

    if (
      canCreateStaticRule &&
      !from.match(SPLAT_REGEX) &&
      !from.match(PLACEHOLDER_REGEX)
    ) {
      staticRules += 1;

      if (staticRules > maxStaticRules) {
        invalid.push({
          message: `Maximum number of static rules supported is ${maxStaticRules}. Skipping line.`,
        });
        continue;
      }
    } else {
      dynamicRules += 1;
      canCreateStaticRule = false;

      if (dynamicRules > maxDynamicRules) {
        invalid.push({
          message: `Maximum number of dynamic rules supported is ${maxDynamicRules}. Skipping remaining ${
            lines.length - i
          } lines of file.`,
        });
        break;
      }
    }

    const toResult = validateUrl(str_to, false, false, true, true);
    if (toResult[0] === undefined) {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: toResult[1],
      });
      continue;
    }
    const to = toResult[0];

    const status = Number(str_status);
    if (isNaN(status) || !PERMITTED_STATUS_CODES.has(status)) {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: `Valid status codes are 200, 301, 302 (default), 303, 307, or 308. Got ${str_status}.`,
      });
      continue;
    }

    // Here we reject two patterns:
    // 1. `/* /index.html` Is always rejected.
    // 2. `/ /index` Is rejected when HTML handling is enabled.
    // Allowing the redirect in other cases will cause TOO_MANY_REDIRECTS errors as the asset Worker will
    // redirect it back to `/` by removing the `/index.html`.
    // We only want to run this on relative URLs.
    const hasRelativePath = !urlHasHost(to);
    const hasWildcardToIndex =
      from.endsWith("/*") && /\/index(.html)?$/.test(to);
    const hasRootToIndex = from.endsWith("/") && /\/index(.html)?$/.test(to);
    const hasHTMLHandling = htmlHandling !== "none"; // HTML handling is enabled by default.
    if (
      hasRelativePath &&
      (hasWildcardToIndex || (hasRootToIndex && hasHTMLHandling))
    ) {
      invalid.push({
        line,
        lineNumber: i + 1,
        message:
          "Infinite loop detected in this rule and has been ignored. This will cause a redirect to strip `.html` or `/index` and end up triggering this rule again. Please fix or remove this rule to silence this warning.",
      });
      continue;
    }

    if (seen_paths.has(from)) {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: `Ignoring duplicate rule for path ${from}.`,
      });
      continue;
    }
    seen_paths.add(from);

    if (status === 200) {
      if (urlHasHost(to)) {
        invalid.push({
          line,
          lineNumber: i + 1,
          message: `Proxy (200) redirects can only point to relative paths. Got ${to}`,
        });
        continue;
      }
    }

    rules.push({ from, to, status, lineNumber: i + 1 });
  }

  return {
    rules,
    invalid,
  };
}
