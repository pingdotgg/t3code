import * as Schema from "effect/Schema";
import type {
  AgentProfileLocator,
  AgentProfileScope,
  AgentRuleDocument,
  AgentRuleSummary,
} from "@t3tools/contracts";
import {
  AgentProfileLocator as AgentProfileLocatorSchema,
  AgentRuleDocument as AgentRuleDocumentSchema,
} from "@t3tools/contracts";
import { formatAgentRuleGlobs, parseAgentRuleGlobs } from "@t3tools/shared/agentRuleGlobs";

const decodeAgentRuleDocumentSchema = Schema.decodeUnknownSync(AgentRuleDocumentSchema);

function decodeAgentRuleDocument(input: unknown): AgentRuleDocument {
  try {
    return decodeAgentRuleDocumentSchema(input);
  } catch {
    throw new Error("Rule settings contain an invalid value.");
  }
}
const decodeAgentProfileLocators = Schema.decodeUnknownSync(
  Schema.Array(AgentProfileLocatorSchema),
);

export interface AgentRuleDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scope: AgentProfileScope;
  readonly globs: string;
  readonly alwaysApply: boolean;
  readonly priority: string;
  readonly profiles: string;
  readonly body: string;
}

export function draftFromRule(
  rule: AgentRuleDocument | null = null,
  scope: AgentProfileScope = "environment",
): AgentRuleDraft {
  return {
    id: rule?.id ?? "",
    name: rule?.name ?? "",
    description: rule?.description ?? "",
    scope: rule?.scope ?? scope,
    globs: formatAgentRuleGlobs(rule?.globs ?? []),
    alwaysApply: rule?.alwaysApply ?? false,
    priority: String(rule?.priority ?? 0),
    profiles: JSON.stringify(rule?.profiles ?? [], null, 2),
    body: rule?.body ?? "",
  };
}

export function buildAgentRuleDocument(
  draft: AgentRuleDraft,
  baseline: AgentRuleDocument | null,
  now = new Date().toISOString(),
): AgentRuleDocument {
  let profiles: ReadonlyArray<AgentProfileLocator>;
  try {
    profiles = decodeAgentProfileLocators(draft.profiles.trim() ? JSON.parse(draft.profiles) : []);
  } catch {
    throw new Error("Profiles must contain a JSON array of profile locators.");
  }
  if (draft.priority.trim().length === 0) throw new Error("Priority is required.");
  const priority = Number(draft.priority);
  if (!Number.isInteger(priority)) throw new Error("Priority must be a whole number.");
  if (priority < -100 || priority > 100) {
    throw new Error("Priority must be a whole number from -100 to 100.");
  }
  return decodeAgentRuleDocument({
    id: draft.id.trim(),
    scope: draft.scope,
    revision: baseline?.revision ?? "a".repeat(64),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    globs: parseAgentRuleGlobs(draft.globs),
    alwaysApply: draft.alwaysApply,
    priority,
    sourcePath: baseline?.sourcePath ?? null,
    updatedAt: now,
    archivedAt: baseline?.archivedAt ?? null,
    profiles,
    body: draft.body,
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

export function sortAgentRules<
  T extends {
    readonly id: string;
    readonly scope: AgentProfileScope;
    readonly name: string;
    readonly archivedAt: string | null;
  },
>(rules: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...rules].sort(
    (left, right) =>
      Number(left.archivedAt !== null) - Number(right.archivedAt !== null) ||
      Number(left.scope === "project") - Number(right.scope === "project") ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}
