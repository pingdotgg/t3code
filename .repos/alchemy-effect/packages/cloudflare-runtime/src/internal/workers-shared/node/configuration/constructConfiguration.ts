// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { relative } from "node:path";
import {
  HEADERS_VERSION,
  PLACEHOLDER_REGEX,
  REDIRECTS_VERSION,
  SPLAT_REGEX,
} from "../../shared/configuration/constants.ts";
import type {
  AssetConfig,
  MetadataHeaders,
  MetadataRedirects,
  MetadataStaticRedirects,
} from "../../shared/types.ts";
import type {
  Logger,
  ParsedHeaders,
  ParsedRedirects,
} from "../../shared/configuration/types.ts";

export function constructRedirects({
  redirects,
  redirectsFile,
  logger,
}: {
  redirects?: ParsedRedirects;
  redirectsFile?: string;
  logger: Logger;
}): Pick<AssetConfig, "redirects"> {
  if (!redirects) {
    return {};
  }

  const num_valid = redirects.rules.length;
  const num_invalid = redirects.invalid.length;

  // exhaustive check, since we could not have parsed `redirects` out of
  // a non-existing redirects file
  const redirectsRelativePath = redirectsFile
    ? relative(process.cwd(), redirectsFile)
    : "";

  logger.log(
    `✨ Parsed ${num_valid} valid redirect rule${num_valid === 1 ? "" : "s"}.`,
  );

  if (num_invalid > 0) {
    let invalidRedirectRulesList = ``;

    for (const { line, lineNumber, message } of redirects.invalid) {
      invalidRedirectRulesList += `▶︎ ${message}\n`;

      if (line) {
        invalidRedirectRulesList += `    at ${redirectsRelativePath}${lineNumber ? `:${lineNumber}` : ""} | ${line}\n\n`;
      }
    }

    logger.warn(
      `Found ${num_invalid} invalid redirect rule${num_invalid === 1 ? "" : "s"}:\n` +
        `${invalidRedirectRulesList}`,
    );
  }

  /* Better to return no Redirects object at all than one with empty rules */
  if (num_valid === 0) {
    return {};
  }

  const staticRedirects: MetadataStaticRedirects = {};
  const dynamicRedirects: MetadataRedirects = {};
  let canCreateStaticRule = true;
  for (const rule of redirects.rules) {
    if (!rule.from.match(SPLAT_REGEX) && !rule.from.match(PLACEHOLDER_REGEX)) {
      if (canCreateStaticRule) {
        staticRedirects[rule.from] = {
          status: rule.status,
          to: rule.to,
          lineNumber: rule.lineNumber,
        };
        continue;
      } else {
        logger.info(
          `The redirect rule ${rule.from} → ${rule.status} ${rule.to} could be made more performant by bringing it above any lines with splats or placeholders.`,
        );
      }
    }

    dynamicRedirects[rule.from] = { status: rule.status, to: rule.to };
    canCreateStaticRule = false;
  }

  return {
    redirects: {
      version: REDIRECTS_VERSION,
      staticRules: staticRedirects,
      rules: dynamicRedirects,
    },
  };
}

export function constructHeaders({
  headers,
  headersFile,
  logger,
}: {
  headers?: ParsedHeaders;
  headersFile?: string;
  logger: Logger;
}): Pick<AssetConfig, "headers"> {
  if (!headers) {
    return {};
  }

  const num_valid = headers.rules.length;
  const num_invalid = headers.invalid.length;

  // exhaustive check, since we could not have parsed `headers` out of
  // a non-existing headers file
  const headersRelativePath = headersFile
    ? relative(process.cwd(), headersFile)
    : "";

  logger.log(
    `✨ Parsed ${num_valid} valid header rule${num_valid === 1 ? "" : "s"}.`,
  );

  if (num_invalid > 0) {
    let invalidHeaderRulesList = ``;

    for (const { line, lineNumber, message } of headers.invalid) {
      invalidHeaderRulesList += `▶︎ ${message}\n`;

      if (line) {
        invalidHeaderRulesList += `    at ${headersRelativePath}${lineNumber ? `:${lineNumber}` : ""} | ${line}\n\n`;
      }
    }

    logger.warn(
      `Found ${num_invalid} invalid header rule${num_invalid === 1 ? "" : "s"}:\n` +
        `${invalidHeaderRulesList}`,
    );
  }

  /* Better to return no Headers object at all than one with empty rules */
  if (num_valid === 0) {
    return {};
  }

  const rules: MetadataHeaders = {};
  for (const rule of headers.rules) {
    const configuredRule: MetadataHeaders[string] = {};

    if (Object.keys(rule.headers).length) {
      configuredRule.set = rule.headers;
    }
    if (rule.unsetHeaders.length) {
      configuredRule.unset = rule.unsetHeaders;
    }

    rules[rule.path] = configuredRule;
  }

  return {
    headers: {
      version: HEADERS_VERSION,
      rules,
    },
  };
}
