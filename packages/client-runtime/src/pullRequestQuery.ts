import type { PullRequestListFilters } from "@t3tools/contracts";

const REVIEW_VALUES: Record<string, PullRequestListFilters["review"]> = {
  approved: "approved",
  changes_requested: "changes-requested",
  "changes-requested": "changes-requested",
  required: "review-required",
  "review-required": "review-required",
  none: "none",
};
const CHECKS_VALUES: Record<string, PullRequestListFilters["checks"]> = {
  success: "passing",
  passing: "passing",
  failure: "failing",
  failing: "failing",
};

const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/g;
const MAX_QUALIFIER_VALUES = 10;
const MAX_QUALIFIER_LENGTH = 200;

function qualifierValue(raw: string): string {
  return raw.replaceAll('"', "").trim();
}

function splitQualifierList(raw: string): string[] {
  return (raw.match(/(?:[^,"]|"[^"]*")+/g) ?? [])
    .map((part) => qualifierValue(part))
    .filter((part) => part.length > 0);
}

function boundedNames(names: ReadonlyArray<string>): string[] {
  return names
    .slice(0, MAX_QUALIFIER_VALUES)
    .map((name) => name.slice(0, MAX_QUALIFIER_LENGTH).trim())
    .filter((name) => name.length > 0);
}

export function parsePullRequestQuery(raw: string): {
  readonly text: string;
  readonly filters: PullRequestListFilters;
} {
  const text: string[] = [];
  const labels: string[][] = [];
  const excludedLabels: string[] = [];
  let author: string | undefined;
  let draft: PullRequestListFilters["draft"];
  let review: PullRequestListFilters["review"];
  let checks: PullRequestListFilters["checks"];
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(token);
    const value = qualifier === null ? "" : qualifierValue(qualifier[3] ?? "");
    const negated = qualifier?.[1] === "-";
    switch (value.length === 0 ? "" : (qualifier?.[2]?.toLowerCase() ?? "")) {
      case "label": {
        const names = boundedNames(splitQualifierList(qualifier?.[3] ?? ""));
        if (names.length === 0) break;
        if (negated) excludedLabels.push(...names);
        else labels.push(names);
        continue;
      }
      case "author":
        if (negated) break;
        author = value.slice(0, MAX_QUALIFIER_LENGTH).trim();
        continue;
      case "draft":
        if (negated || (value.toLowerCase() !== "true" && value.toLowerCase() !== "false")) break;
        draft = value.toLowerCase() === "true" ? "only" : "hide";
        continue;
      case "review": {
        const decision = negated ? undefined : REVIEW_VALUES[value.toLowerCase()];
        if (decision === undefined) break;
        review = decision;
        continue;
      }
      case "status":
      case "checks": {
        const state = negated ? undefined : CHECKS_VALUES[value.toLowerCase()];
        if (state === undefined) break;
        checks = state;
        continue;
      }
      case "":
        break;
      default:
        if (!value.startsWith("/")) {
          const names = boundedNames(
            splitQualifierList(qualifier?.[3] ?? "").map((name) =>
              name.includes(":") ? name : `${qualifier?.[2] ?? ""}:${name}`,
            ),
          );
          if (names.length === 0) break;
          if (negated) excludedLabels.push(...names);
          else labels.push(names);
          continue;
        }
    }
    text.push(token);
  }
  return {
    text: text.join(" "),
    filters: {
      ...(labels.length === 0 ? {} : { labels: labels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(excludedLabels.length === 0
        ? {}
        : { excludedLabels: excludedLabels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(author === undefined ? {} : { author }),
      ...(draft === undefined ? {} : { draft }),
      ...(review === undefined ? {} : { review }),
      ...(checks === undefined ? {} : { checks }),
    },
  };
}

/**
 * The Draft menu shows a typed `draft:` qualifier, so picking another value has to take the
 * qualifier out of the query: left in, it would keep outranking whatever the menu stores.
 */
export function applyPullRequestDraftFilterChange(
  query: string,
  menuFilters: PullRequestListFilters,
  next: PullRequestListFilters,
) {
  const typedDraft = parsePullRequestQuery(query).filters.draft;
  if (next.draft === (typedDraft ?? menuFilters.draft))
    return { query, filters: { ...next, draft: menuFilters.draft } };
  return {
    query:
      typedDraft === undefined
        ? query
        : [...query.matchAll(QUERY_TOKEN)]
            .map(([token]) => token)
            .filter((token) => parsePullRequestQuery(token).filters.draft === undefined)
            .join(" "),
    filters: next,
  };
}
