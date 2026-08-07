import * as Schema from "effect/Schema";

import {
  AgentRuleDocument as AgentRuleDocumentSchema,
  AgentProfileLocator as AgentProfileLocatorSchema,
  type AgentRuleDocument,
} from "@t3tools/contracts";

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
    globs: rule?.globs.join(", ") ?? "",
    alwaysApply: rule?.alwaysApply ?? false,
    priority: String(rule?.priority ?? 0),
    profiles: rule?.profiles.map((profile) => `${profile.scope}:${profile.id}`).join(", ") ?? "",
    body: rule?.body ?? "",
    scope: rule?.scope ?? scope,
  };
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -100 || parsed > 100) {
    throw new Error("Priority must be a whole number from -100 to 100.");
  }
  return parsed;
}

function parseGlobs(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseProfiles(
  value: string,
): ReadonlyArray<{ readonly id: string; readonly scope: "environment" | "project" }> {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [scope, id] = item.includes(":") ? item.split(":", 2) : ["environment", item];
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
  return Schema.decodeUnknownSync(AgentRuleDocumentSchema)({
    id: draft.id.trim(),
    scope: draft.scope,
    revision: baseline?.revision ?? "a".repeat(64),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    globs: parseGlobs(draft.globs),
    alwaysApply: draft.alwaysApply,
    priority: parseInteger(draft.priority),
    sourcePath: baseline?.sourcePath ?? null,
    archivedAt: baseline?.archivedAt ?? null,
    updatedAt: now,
    body: draft.body,
    profiles: Schema.decodeUnknownSync(Schema.Array(AgentProfileLocatorSchema))(
      parseProfiles(draft.profiles),
    ),
    createdAt: baseline?.createdAt ?? now,
  });
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
