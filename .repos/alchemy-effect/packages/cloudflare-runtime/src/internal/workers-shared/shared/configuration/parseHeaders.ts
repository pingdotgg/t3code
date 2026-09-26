// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import {
  HEADER_SEPARATOR,
  MAX_HEADER_RULES,
  MAX_LINE_LENGTH,
  SPLAT_REGEX,
  UNSET_OPERATOR,
} from "./constants.ts";
import { validateUrl } from "./validateURL.ts";
import type {
  HeadersRule,
  InvalidHeadersRule,
  ParsedHeaders,
} from "./types.ts";

// Not strictly necessary to check for all protocols-like beginnings, since _technically_ that could be a legit header (e.g. name=http, value=://I'm a value).
// But we're checking here since some people might be caught out and it'll help 99.9% of people who get it wrong.
// We do the proper validation in `validateUrl` anyway :)
const LINE_IS_PROBABLY_A_PATH = new RegExp(/^([^\s]+:\/\/|^\/)/);

export function parseHeaders(
  input: string,
  {
    maxRules = MAX_HEADER_RULES,
    maxLineLength = MAX_LINE_LENGTH,
  }: { maxRules?: number; maxLineLength?: number } = {},
): ParsedHeaders {
  const lines = input.split("\n");
  const rules: Array<HeadersRule> = [];
  const invalid: Array<InvalidHeadersRule> = [];

  let rule: (HeadersRule & { line: string }) | undefined = undefined;
  // When a path line is rejected (invalid URL, multiple wildcards, etc.),
  // we silently skip subsequent header lines until the next path line
  // rather than emitting confusing "Path should come before header" errors.
  let skipUntilNextPath = false;

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

    if (LINE_IS_PROBABLY_A_PATH.test(line)) {
      skipUntilNextPath = false;

      if (rules.length >= maxRules) {
        invalid.push({
          message: `Maximum number of rules supported is ${maxRules}. Skipping remaining ${
            lines.length - i
          } lines of file.`,
        });
        break;
      }

      if (rule) {
        if (isValidRule(rule)) {
          rules.push({
            path: rule.path,
            headers: rule.headers,
            unsetHeaders: rule.unsetHeaders,
          });
        } else {
          invalid.push({
            line: rule.line,
            lineNumber: i + 1,
            message: "No headers specified",
          });
        }
      }

      const [path, pathError] = validateUrl(line, false, true);
      if (pathError) {
        invalid.push({
          line,
          lineNumber: i + 1,
          message: pathError,
        });
        rule = undefined;
        skipUntilNextPath = true;
        continue;
      }

      const wildcardError = validateNoMultipleWildcards(path as string);
      if (wildcardError) {
        invalid.push({
          line,
          lineNumber: i + 1,
          message: wildcardError,
        });
        rule = undefined;
        skipUntilNextPath = true;
        continue;
      }

      rule = {
        path: path as string,
        line,
        headers: {},
        unsetHeaders: [],
      };
      continue;
    }

    if (skipUntilNextPath) {
      continue;
    }

    if (!line.includes(HEADER_SEPARATOR)) {
      if (!rule) {
        invalid.push({
          line,
          lineNumber: i + 1,
          message: "Expected a path beginning with at least one forward-slash",
        });
      } else {
        if (line.trim().startsWith(UNSET_OPERATOR)) {
          rule.unsetHeaders.push(line.trim().replace(UNSET_OPERATOR, ""));
        } else {
          invalid.push({
            line,
            lineNumber: i + 1,
            message:
              "Expected a colon-separated header pair (e.g. name: value)",
          });
        }
      }
      continue;
    }

    const [rawName, ...rawValue] = line.split(HEADER_SEPARATOR);
    const name = (rawName || "").trim().toLowerCase();

    if (name.includes(" ")) {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: "Header name cannot include spaces",
      });
      continue;
    }

    const value = rawValue.join(HEADER_SEPARATOR).trim();

    if (name === "") {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: "No header name specified",
      });
      continue;
    }

    if (value === "") {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: "No header value specified",
      });
      continue;
    }

    if (!rule) {
      invalid.push({
        line,
        lineNumber: i + 1,
        message: `Path should come before header (${name}: ${value})`,
      });
      continue;
    }

    const existingValues = rule.headers[name];
    rule.headers[name] = existingValues ? `${existingValues}, ${value}` : value;
  }

  if (rule) {
    if (isValidRule(rule)) {
      rules.push({
        path: rule.path,
        headers: rule.headers,
        unsetHeaders: rule.unsetHeaders,
      });
    } else {
      invalid.push({ line: rule.line, message: "No headers specified" });
    }
  }

  return {
    rules,
    invalid,
  };
}

function isValidRule(rule: HeadersRule) {
  return Object.keys(rule.headers).length > 0 || rule.unsetHeaders.length > 0;
}

/**
 * At runtime, `*` wildcards are converted to `:splat` placeholders. This means
 * a path with multiple wildcards, or a wildcard combined with an explicit
 * `:splat` placeholder, would result in duplicate `:splat` parameters which is
 * unsupported.
 */
function validateNoMultipleWildcards(path: string): string | undefined {
  const wildcardCount = (path.match(SPLAT_REGEX) ?? []).length;
  const hasSplatPlaceholder = /:splat(?!\w)/.test(path);

  if (wildcardCount > 1) {
    return `Only one wildcard is allowed per rule. Use a named placeholder (e.g. :project) instead. Skipping ${path}.`;
  }

  if (wildcardCount > 0 && hasSplatPlaceholder) {
    return `Cannot combine a wildcard * with a :splat placeholder because wildcards are converted to :splat at runtime. Skipping ${path}.`;
  }

  return undefined;
}
