import * as Schema from "effect/Schema";

import {
  AgentRuleDocument as AgentRuleDocumentSchema,
  AgentProfileLocator as AgentProfileLocatorSchema,
  type AgentRuleDocument,
  type AgentRuleSummary,
} from "@t3tools/contracts";
import { formatAgentRuleGlobs, parseAgentRuleGlobs } from "@t3tools/shared/agentRuleGlobs";

import { parseRequiredNumber } from "./agentSettings.logic";

const decodeAgentRuleDocumentSchema = Schema.decodeUnknownSync(AgentRuleDocumentSchema);
const decodeAgentProfileLocators = Schema.decodeUnknownSync(
  Schema.Array(AgentProfileLocatorSchema),
);

function decodeAgentRuleDocument(input: unknown): AgentRuleDocument {
  try {
    return decodeAgentRuleDocumentSchema(input);
  } catch {
    throw new Error("Rule settings contain an invalid value.");
  }
}

export type AgentRuleDraft = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly globs: string;
  readonly alwaysApply: boolean;
  readonly priority: string;
  readonly profiles: string;
  readonly body: string;
  readonly scope: "environment" | "project";
};

export function draftFromRule(
  rule?: AgentRuleDocument | null,
  scope: AgentRuleDraft["scope"] = "environment",
): AgentRuleDraft {
  return {
    id: rule?.id ?? "",
    name: rule?.name ?? "",
    description: rule?.description ?? "",
    globs: formatAgentRuleGlobs(rule?.globs ?? []),
    alwaysApply: rule?.alwaysApply ?? false,
    priority: String(rule?.priority ?? 0),
    profiles: rule?.profiles.map((profile) => `${profile.scope}:${profile.id}`).join(", ") ?? "",
    body: rule?.body ?? "",
    scope: rule?.scope ?? scope,
  };
}

function parseInteger(value: string): number {
  const parsed = parseRequiredNumber(value, "Priority");
  if (!Number.isInteger(parsed) || parsed < -100 || parsed > 100) {
    throw new Error("Priority must be a whole number from -100 to 100.");
  }
  return parsed;
}

function parseProfiles(
  value: string,
): ReadonlyArray<{ readonly id: string; readonly scope: "environment" | "project" }> {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(":");
      const [scope, id] =
        separator === -1
          ? ["environment", item]
          : [item.slice(0, separator), item.slice(separator + 1)];
      if ((scope !== "environment" && scope !== "project") || !id) {
        throw new Error("Profile targets must use profile-id or scope:profile-id.");
      }
      return { scope, id } as const;
    });
}

export function buildAgentRuleDocument(
  draft: AgentRuleDraft,
  baseline: AgentRuleDocument | null,
  now = new Date().toISOString(),
): AgentRuleDocument {
  return decodeAgentRuleDocument({
    id: draft.id.trim(),
    scope: draft.scope,
    revision: baseline?.revision ?? "a".repeat(64),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    globs: parseAgentRuleGlobs(draft.globs),
    alwaysApply: draft.alwaysApply,
    priority: parseInteger(draft.priority),
    sourcePath: baseline?.sourcePath ?? null,
    archivedAt: baseline?.archivedAt ?? null,
    updatedAt: now,
    body: draft.body,
    profiles: decodeAgentProfileLocators(parseProfiles(draft.profiles)),
    createdAt: baseline?.createdAt ?? now,
  });
}

export function resolveRuleBaselineForSave(
  isNew: boolean,
  selected: Pick<AgentRuleSummary, "id" | "scope" | "revision"> | null,
  loaded: AgentRuleDocument | undefined,
): AgentRuleDocument | null {
  if (isNew) return null;
  if (
    loaded === undefined ||
    selected === null ||
    loaded.id !== selected.id ||
    loaded.scope !== selected.scope ||
    loaded.revision !== selected.revision
  ) {
    throw new Error("Load the current rule before saving it.");
  }
  return loaded;
}

export function isRuleDocumentForSummary(
  rule: AgentRuleDocument | undefined,
  summary: Pick<AgentRuleSummary, "id" | "scope" | "revision"> | null,
): rule is AgentRuleDocument {
  return (
    rule !== undefined &&
    summary !== null &&
    rule.id === summary.id &&
    rule.scope === summary.scope &&
    rule.revision === summary.revision
  );
}

export function sortAgentRules<
  T extends { readonly id: string; readonly name: string; readonly archivedAt: string | null },
>(rules: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...rules].sort(
    (left, right) =>
      Number(left.archivedAt !== null) - Number(right.archivedAt !== null) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}
