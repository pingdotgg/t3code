// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { MAX_ROUTES_RULE_LENGTH, MAX_ROUTES_RULES } from "./constants.ts";
import type { StaticRouting } from "../types.ts";

// copy of what EWC does. Wrangler uploads the rules in one array (so the API is consistent with Wrangler config),
// but router Worker expects the rules to be split into two arrays, which we do here.
// This logic is translated from assets/staticrouting.go.

export function parseStaticRouting(input: Array<string>): StaticRouting {
  if (input.length === 0) {
    throw new Error(
      "No `run_worker_first` rules were provided; must provide at least 1 rule.",
    );
  }
  if (input.length > MAX_ROUTES_RULES) {
    throw new Error(
      `Too many \`run_worker_first\` rules were provided; ${input.length} rules provided exceeds max of ${MAX_ROUTES_RULES}.`,
    );
  }

  const rawAssetWorkerRules = [];
  const assetWorkerRules = [];
  const userWorkerRules = [];
  const invalidRules = [];

  for (const rule of input) {
    if (rule.startsWith("!/")) {
      assetWorkerRules.push(rule.slice(1)); // Remove leading !
      rawAssetWorkerRules.push(rule);
    } else if (rule.startsWith("/")) {
      userWorkerRules.push(rule);
    } else if (rule.startsWith("!")) {
      invalidRules.push(`'${rule}': negative rules must start with '!/'`);
    } else {
      invalidRules.push(`'${rule}': rules must start with '/' or '!/'`);
    }
  }

  if (assetWorkerRules.length > 0 && userWorkerRules.length === 0) {
    throw new Error(
      "Only negative `run_worker_first` rules were provided; must provide at least 1 non-negative rule",
    );
  }

  const invalidAssetWorkerRules =
    validateStaticRoutingRules(rawAssetWorkerRules);
  const invalidUserWorkerRules = validateStaticRoutingRules(userWorkerRules);
  const errorMessage = formatInvalidRoutes([
    ...invalidRules,
    ...invalidUserWorkerRules,
    ...invalidAssetWorkerRules,
  ]);

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return { asset_worker: assetWorkerRules, user_worker: userWorkerRules };
}

function validateStaticRoutingRules(rules: Array<string>): Array<string> {
  const invalid: Array<string> = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.length > MAX_ROUTES_RULE_LENGTH) {
      invalid.push(
        `'${rule}': all rules must be less than ${MAX_ROUTES_RULE_LENGTH} characters in length`,
      );
    }
    if (seen.has(rule)) {
      invalid.push(`'${rule}': rule is a duplicate; rules must be unique`);
    }
    if (rule.endsWith("*")) {
      // Check for redundant rules due to a glob
      for (const otherRule of rules) {
        if (otherRule !== rule && otherRule.startsWith(rule.slice(0, -1))) {
          invalid.push(`'${otherRule}': rule '${rule}' makes it redundant`);
        }
      }
    }
    seen.add(rule);
  }
  return invalid;
}

const formatInvalidRoutes = (invalidRules: Array<string>) => {
  if (invalidRules.length === 0) {
    return undefined;
  }
  return `Invalid routes in \`run_worker_first\`:\n` + invalidRules.join("\n");
};
