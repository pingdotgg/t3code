import * as Schema from "effect/Schema";
import type {
  AgentProfileDocument,
  AgentProfileSummary,
  AgentProfileScope,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  AgentHook as AgentHookSchema,
  AgentProfileDocument as AgentProfileDocumentSchema,
  AgentProfileLocator as AgentProfileLocatorSchema,
  AgentRuleRef as AgentRuleRefSchema,
} from "@t3tools/contracts";

export interface AgentProfileDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly instructionPriority: "prompt" | "system-required";
  readonly scope: AgentProfileScope;
  readonly projectId: string;
  readonly defaultModelSelection: string;
  readonly chatSelectable: boolean;
  readonly toolRequirement: "none" | "sandbox" | "exact";
  readonly t3McpCapabilities: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "shared" | "isolated-worktree";
  readonly workspaceAccess: "read-only" | "workspace-write" | "full-access";
  readonly sharedWriteConcurrency: string;
  readonly toolsPolicy: "inherit" | "allowlist";
  readonly allowedTools: string;
  readonly delegationPolicy: "disabled" | "allowlist";
  readonly delegatedProfiles: string;
  readonly maxRuns: string;
  readonly maxConcurrency: string;
  readonly maxDepth: string;
  readonly maxWallTimeMinutes: string;
  readonly maxTotalTokens: string;
  readonly maxEstimatedCostUsd: string;
  readonly hooks: string;
  readonly rules: string;
}

export interface AgentProfileDraftSource {
  readonly profile?: AgentProfileDocument | null;
  readonly scope?: AgentProfileScope;
  readonly projectId?: string;
}

export function agentSettingsContextKey(input: {
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly selectionKey: string | null;
  readonly generation: number;
}): string {
  return `${input.environmentId ?? ""}:${input.projectId ?? ""}:${input.selectionKey ?? ""}:${input.generation}`;
}

const EMPTY_JSON_ARRAY = "[]";
const decodeAgentProfileLocators = Schema.decodeUnknownSync(
  Schema.Array(AgentProfileLocatorSchema),
);
const decodeAgentHooks = Schema.decodeUnknownSync(Schema.Array(AgentHookSchema));
const decodeAgentRuleRefs = Schema.decodeUnknownSync(Schema.Array(AgentRuleRefSchema));
const decodeAgentProfileDocumentSchema = Schema.decodeUnknownSync(AgentProfileDocumentSchema);

function decodeAgentProfileDocument(input: unknown): AgentProfileDocument {
  try {
    return decodeAgentProfileDocumentSchema(input);
  } catch {
    throw new Error("Profile settings contain an invalid value.");
  }
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function csv(values: ReadonlyArray<string>): string {
  return values.join(", ");
}

export function draftFromProfile(source: AgentProfileDraftSource = {}): AgentProfileDraft {
  const profile = source.profile;
  return {
    id: profile?.id ?? "",
    name: profile?.name ?? "",
    description: profile?.description ?? "",
    instructions: profile?.instructions ?? "",
    instructionPriority: profile?.instructionPriority ?? "prompt",
    scope: profile?.scope ?? source.scope ?? "environment",
    projectId: source.projectId ?? "",
    defaultModelSelection: profile?.defaultModelSelection
      ? jsonValue(profile.defaultModelSelection)
      : "",
    chatSelectable: profile?.chatSelectable ?? true,
    toolRequirement: profile?.requirements.toolRequirement ?? "none",
    t3McpCapabilities: csv(profile?.requirements.t3McpCapabilities ?? []),
    runtimeMode: profile?.runtime.mode ?? "auto",
    interactionMode: profile?.runtime.interactionMode ?? "default",
    workspaceMode: profile?.workspace.mode ?? "shared",
    workspaceAccess: profile?.workspace.access ?? "workspace-write",
    sharedWriteConcurrency:
      profile?.workspace.sharedWriteConcurrency === undefined
        ? ""
        : String(profile.workspace.sharedWriteConcurrency),
    toolsPolicy: profile?.tools.policy ?? "inherit",
    allowedTools: csv(profile?.tools.allowed ?? []),
    delegationPolicy: profile?.delegation.policy ?? "disabled",
    delegatedProfiles: profile ? jsonValue(profile.delegation.profiles) : EMPTY_JSON_ARRAY,
    maxRuns: String(profile?.budgets.maxRuns ?? 1),
    maxConcurrency: String(profile?.budgets.maxConcurrency ?? 1),
    maxDepth: String(profile?.budgets.maxDepth ?? 0),
    maxWallTimeMinutes: String(profile?.budgets.maxWallTimeMinutes ?? 120),
    maxTotalTokens:
      profile?.budgets.maxTotalTokens === undefined ? "" : String(profile.budgets.maxTotalTokens),
    maxEstimatedCostUsd:
      profile?.budgets.maxEstimatedCostUsd === undefined
        ? ""
        : String(profile.budgets.maxEstimatedCostUsd),
    hooks: profile ? jsonValue(profile.hooks) : EMPTY_JSON_ARRAY,
    rules: profile ? jsonValue(profile.rules) : EMPTY_JSON_ARRAY,
  };
}

function parseJson(value: string, label: string): unknown {
  if (value.trim().length === 0) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function parseList(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseInteger(value: string, label: string): number {
  if (value.trim().length === 0) throw new Error(`${label} is required.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be a whole number.`);
  return parsed;
}

function parseOptionalInteger(value: string, label: string): number | undefined {
  return value.trim().length === 0 ? undefined : parseInteger(value, label);
}

function parseOptionalNumber(value: string, label: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
  return parsed;
}

export function buildAgentProfileDocument(
  draft: AgentProfileDraft,
  baseline: AgentProfileDocument | null,
  now = new Date().toISOString(),
): AgentProfileDocument {
  const defaultModelSelection = parseJson(draft.defaultModelSelection, "Default model selection");
  const delegatedProfiles = decodeAgentProfileLocators(
    parseJson(draft.delegatedProfiles, "Delegated profiles") ?? [],
  );
  const hooks = decodeAgentHooks(parseJson(draft.hooks, "Hooks") ?? []);
  const rules = decodeAgentRuleRefs(parseJson(draft.rules, "Rules") ?? []);
  const document = {
    id: draft.id.trim(),
    scope: draft.scope,
    revision: baseline?.revision ?? "a".repeat(64),
    name: draft.name.trim(),
    ...(draft.description.trim().length > 0 ? { description: draft.description.trim() } : {}),
    defaultModelSelection: (defaultModelSelection ?? null) as ModelSelection | null,
    chatSelectable: draft.chatSelectable,
    sourcePath: baseline?.sourcePath ?? null,
    requirements: {
      toolRequirement: draft.toolRequirement,
      t3McpCapabilities: parseList(draft.t3McpCapabilities),
    },
    archivedAt: baseline?.archivedAt ?? null,
    updatedAt: now,
    instructions: draft.instructions,
    instructionPriority: draft.instructionPriority,
    runtime: { mode: draft.runtimeMode, interactionMode: draft.interactionMode },
    workspace: {
      mode: draft.workspaceMode,
      access: draft.workspaceAccess,
      ...(parseOptionalInteger(draft.sharedWriteConcurrency, "Shared write concurrency") ===
      undefined
        ? {}
        : {
            sharedWriteConcurrency: parseOptionalInteger(
              draft.sharedWriteConcurrency,
              "Shared write concurrency",
            ),
          }),
    },
    tools: { policy: draft.toolsPolicy, allowed: parseList(draft.allowedTools) },
    delegation: { policy: draft.delegationPolicy, profiles: delegatedProfiles },
    budgets: {
      maxRuns: parseInteger(draft.maxRuns, "Maximum runs"),
      maxConcurrency: parseInteger(draft.maxConcurrency, "Maximum concurrency"),
      maxDepth: parseInteger(draft.maxDepth, "Maximum delegation depth"),
      maxWallTimeMinutes: parseInteger(draft.maxWallTimeMinutes, "Maximum wall time"),
      ...(parseOptionalInteger(draft.maxTotalTokens, "Maximum total tokens") === undefined
        ? {}
        : { maxTotalTokens: parseOptionalInteger(draft.maxTotalTokens, "Maximum total tokens") }),
      ...(parseOptionalNumber(draft.maxEstimatedCostUsd, "Maximum estimated cost") === undefined
        ? {}
        : {
            maxEstimatedCostUsd: parseOptionalNumber(
              draft.maxEstimatedCostUsd,
              "Maximum estimated cost",
            ),
          }),
    },
    hooks,
    rules,
    createdAt: baseline?.createdAt ?? now,
  };
  return decodeAgentProfileDocument(document);
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

export function sortAgentProfiles<
  T extends {
    readonly id: string;
    readonly scope: AgentProfileScope;
    readonly name: string;
    readonly archivedAt: string | null;
  },
>(profiles: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...profiles].sort((left, right) => {
    const archived = Number(left.archivedAt !== null) - Number(right.archivedAt !== null);
    if (archived !== 0) return archived;
    const scope = Number(left.scope === "project") - Number(right.scope === "project");
    if (scope !== 0) return scope;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}
