import * as Schema from "effect/Schema";

import {
  AgentProfileDocument as AgentProfileDocumentSchema,
  type AgentProfileDocument,
  type AgentProfileSummary,
} from "@t3tools/contracts";

import { parseRequiredNumber } from "./agentSettings.logic";

const decodeAgentProfileDocumentSchema = Schema.decodeUnknownSync(AgentProfileDocumentSchema);

function decodeAgentProfileDocument(input: unknown): AgentProfileDocument {
  try {
    return decodeAgentProfileDocumentSchema(input);
  } catch {
    throw new Error("Profile settings contain an invalid value.");
  }
}

export type AgentProfileDraft = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly instructionPriority: "prompt" | "system-required";
  readonly scope: "environment" | "project";
  readonly chatSelectable: boolean;
  readonly runtimeMode: "full-access" | "auto" | "auto-accept-edits" | "approval-required";
  readonly interactionMode: "default" | "plan";
  readonly workspaceMode: "shared" | "isolated-worktree";
  readonly workspaceAccess: "read-only" | "workspace-write" | "full-access";
  readonly maxRuns: string;
  readonly maxConcurrency: string;
  readonly maxDepth: string;
  readonly maxWallTimeMinutes: string;
};

export function draftFromProfile(
  profile?: AgentProfileDocument | null,
  scope: AgentProfileDraft["scope"] = "environment",
): AgentProfileDraft {
  return {
    id: profile?.id ?? "",
    name: profile?.name ?? "",
    description: profile?.description ?? "",
    instructions: profile?.instructions ?? "",
    instructionPriority: profile?.instructionPriority ?? "prompt",
    scope: profile?.scope ?? scope,
    chatSelectable: profile?.chatSelectable ?? true,
    runtimeMode: profile?.runtime.mode ?? "auto",
    interactionMode: profile?.runtime.interactionMode ?? "default",
    workspaceMode: profile?.workspace.mode ?? "shared",
    workspaceAccess: profile?.workspace.access ?? "workspace-write",
    maxRuns: String(profile?.budgets.maxRuns ?? 1),
    maxConcurrency: String(profile?.budgets.maxConcurrency ?? 1),
    maxDepth: String(profile?.budgets.maxDepth ?? 0),
    maxWallTimeMinutes: String(profile?.budgets.maxWallTimeMinutes ?? 120),
  };
}

function integer(value: string, label: string): number {
  const parsed = parseRequiredNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative whole number.`);
  return parsed;
}

export function buildAgentProfileDocument(
  draft: AgentProfileDraft,
  baseline: AgentProfileDocument | null,
  now = new Date().toISOString(),
): AgentProfileDocument {
  return decodeAgentProfileDocument({
    id: draft.id.trim(),
    scope: draft.scope,
    revision: baseline?.revision ?? "a".repeat(64),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    defaultModelSelection: baseline?.defaultModelSelection ?? null,
    chatSelectable: draft.chatSelectable,
    sourcePath: baseline?.sourcePath ?? null,
    requirements: baseline?.requirements ?? { toolRequirement: "none", t3McpCapabilities: [] },
    archivedAt: baseline?.archivedAt ?? null,
    updatedAt: now,
    instructions: draft.instructions,
    instructionPriority: draft.instructionPriority,
    runtime: { mode: draft.runtimeMode, interactionMode: draft.interactionMode },
    workspace: {
      mode: draft.workspaceMode,
      access: draft.workspaceAccess,
      ...(baseline?.workspace.sharedWriteConcurrency === undefined
        ? {}
        : { sharedWriteConcurrency: baseline.workspace.sharedWriteConcurrency }),
    },
    tools: baseline?.tools ?? { policy: "inherit", allowed: [] },
    delegation: baseline?.delegation ?? { policy: "disabled", profiles: [] },
    budgets: {
      maxRuns: integer(draft.maxRuns, "Maximum runs"),
      maxConcurrency: integer(draft.maxConcurrency, "Maximum concurrency"),
      maxDepth: integer(draft.maxDepth, "Maximum delegation depth"),
      maxWallTimeMinutes: integer(draft.maxWallTimeMinutes, "Maximum wall time"),
      ...(baseline?.budgets.maxTotalTokens === undefined
        ? {}
        : { maxTotalTokens: baseline.budgets.maxTotalTokens }),
      ...(baseline?.budgets.maxEstimatedCostUsd === undefined
        ? {}
        : { maxEstimatedCostUsd: baseline.budgets.maxEstimatedCostUsd }),
    },
    hooks: baseline?.hooks ?? [],
    rules: baseline?.rules ?? [],
    createdAt: baseline?.createdAt ?? now,
  });
}

export function resolveProfileBaselineForSave(
  isNew: boolean,
  selected: Pick<AgentProfileSummary, "id" | "scope" | "revision"> | null,
  loaded: AgentProfileDocument | undefined,
): AgentProfileDocument | null {
  if (isNew) return null;
  if (
    loaded === undefined ||
    selected === null ||
    loaded.id !== selected.id ||
    loaded.scope !== selected.scope ||
    loaded.revision !== selected.revision
  ) {
    throw new Error("Load the current profile before saving it.");
  }
  return loaded;
}

export function isProfileDocumentForSummary(
  profile: AgentProfileDocument | undefined,
  summary: Pick<AgentProfileSummary, "id" | "scope" | "revision"> | null,
): profile is AgentProfileDocument {
  return (
    profile !== undefined &&
    summary !== null &&
    profile.id === summary.id &&
    profile.scope === summary.scope &&
    profile.revision === summary.revision
  );
}

export function sortAgentProfiles<
  T extends { id: string; name: string; scope: string; archivedAt: string | null },
>(profiles: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...profiles].sort((left, right) => {
    const archived = Number(left.archivedAt !== null) - Number(right.archivedAt !== null);
    return archived || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

export function selectChatAgentProfiles<
  T extends { id: string; scope: string; chatSelectable: boolean; archivedAt: string | null },
>(profiles: ReadonlyArray<T>, selected: { id: string; scope: string } | null): ReadonlyArray<T> {
  return profiles.filter(
    (profile) =>
      (profile.archivedAt === null && profile.chatSelectable) ||
      (selected !== null && profile.id === selected.id && profile.scope === selected.scope),
  );
}
