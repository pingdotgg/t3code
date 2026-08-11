import * as NodeCrypto from "node:crypto";

import type {
  AgentProfileBudgets,
  AgentProfileDocument,
  AgentRuleDocument,
} from "@t3tools/contracts";

import {
  compileAgentRules,
  normalizeWorkspaceRelativePath,
  type AgentRuleMatchDiagnostic,
} from "./RuleMatcher.ts";

export type AgentPromptValue = string | readonly string[] | Readonly<Record<string, unknown>>;

export interface AgentPromptLineage {
  readonly parentRunId?: string;
  readonly rootRunId?: string;
  readonly depth?: number;
  readonly ancestors?: readonly string[];
}

export interface AgentPromptBudget extends Partial<AgentProfileBudgets> {
  readonly remainingTokens?: number;
  readonly remainingCostUsd?: number;
}

export interface AgentPromptCompileInput {
  /** A revision-pinned profile; this function never looks it up. */
  readonly profile: AgentProfileDocument;
  /** The user's task, kept byte-for-byte in the envelope's task field. */
  readonly cleanTask: string;
  readonly handoff?: AgentPromptValue;
  readonly context?: AgentPromptValue;
  readonly files?: readonly string[];
  readonly rules?: readonly AgentRuleDocument[];
  readonly hookContext?: AgentPromptValue;
  readonly lineage?: AgentPromptLineage;
  readonly budget?: AgentPromptBudget;
  readonly toolNames?: readonly string[];
  readonly contextFiles?: readonly string[];
}

export interface AgentPortablePromptEnvelope {
  readonly version: 1;
  readonly profile: {
    readonly id: string;
    readonly scope: "environment" | "project";
    readonly revision: string;
  };
  readonly instructions: string;
  readonly task: string;
  readonly handoff?: AgentPromptValue;
  readonly context?: AgentPromptValue;
  readonly files: readonly string[];
  readonly rules: readonly AgentRuleDocument[];
  readonly hookContext?: AgentPromptValue;
  readonly lineage?: AgentPromptLineage;
  readonly budget?: AgentPromptBudget;
  readonly toolNames: readonly string[];
  /** Stable text form adapters can send as a normal user turn. */
  readonly text: string;
}

export interface AgentPromptHashes {
  readonly profile: string;
  readonly rules: string;
  readonly task: string;
  readonly nativeInstructions: string;
  readonly portablePrompt: string;
}

export interface AgentPromptDiagnostic {
  readonly code: AgentRuleMatchDiagnostic["code"] | "duplicate-file" | "unknown-tool";
  readonly message: string;
  readonly value: string;
}

export interface AgentPromptCompilation {
  readonly nativeInstructions: string;
  readonly portablePrompt: AgentPortablePromptEnvelope;
  /** Alias for callers that use the longer domain name. */
  readonly portablePromptEnvelope: AgentPortablePromptEnvelope;
  readonly hashes: AgentPromptHashes;
  readonly diagnostics: readonly AgentPromptDiagnostic[];
}

const hash = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
};

const stableJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const T3_AGENT_RUNTIME_CONTEXT =
  "You are running inside T3 Code with a revision-pinned Agent profile. T3 Agent MCP tools (agent_list, agent_spawn, agent_status, agent_wait, agent_result, agent_send, agent_cancel, and agent_integrate) orchestrate provider-neutral child threads when this profile permits delegation.";

const renderValue = (value: AgentPromptValue): string =>
  typeof value === "string" ? value : stableJson(value);

const section = (title: string, value: string): string => `## ${title}\n${value}`;

const normalizeFiles = (
  files: readonly string[] | undefined,
  diagnostics: AgentPromptDiagnostic[],
): string[] => {
  const result: string[] = [];
  for (const file of files ?? []) {
    try {
      const normalized = normalizeWorkspaceRelativePath(file);
      if (result.includes(normalized)) {
        diagnostics.push({
          code: "duplicate-file",
          message: `File '${normalized}' was supplied more than once.`,
          value: file,
        });
      } else {
        result.push(normalized);
      }
    } catch (error) {
      diagnostics.push({
        code: "invalid-path",
        message: error instanceof Error ? error.message : "Invalid workspace-relative path.",
        value: file,
      });
    }
  }
  return result;
};

const renderPortablePrompt = (envelope: Omit<AgentPortablePromptEnvelope, "text">): string => {
  const sections: string[] = [
    "<!-- t3-agent-prompt:v1 -->",
    section("T3 runtime", T3_AGENT_RUNTIME_CONTEXT),
  ];
  if (envelope.instructions.length > 0) {
    sections.push(section("Agent instructions", envelope.instructions));
  }
  if (envelope.handoff !== undefined)
    sections.push(section("Handoff", renderValue(envelope.handoff)));
  if (envelope.context !== undefined)
    sections.push(section("Context", renderValue(envelope.context)));
  if (envelope.files.length > 0) sections.push(section("Files", envelope.files.join("\n")));
  if (envelope.rules.length > 0) {
    sections.push(
      section(
        "Rules",
        envelope.rules.map((rule) => `### ${rule.scope}/${rule.id}\n${rule.body}`).join("\n\n"),
      ),
    );
  }
  if (envelope.hookContext !== undefined) {
    sections.push(section("Hook context", renderValue(envelope.hookContext)));
  }
  if (envelope.lineage !== undefined)
    sections.push(section("Lineage", stableJson(envelope.lineage)));
  if (envelope.budget !== undefined) sections.push(section("Budget", stableJson(envelope.budget)));
  if (envelope.toolNames.length > 0) sections.push(section("Tools", envelope.toolNames.join(", ")));
  sections.push(section("Task", envelope.task));
  return sections.join("\n\n");
};

/**
 * Compile provider-neutral prompt material. No provider adapter is consulted,
 * and `cleanTask` is never trimmed, escaped, or otherwise rewritten.
 */
export const compileAgentPrompt = (input: AgentPromptCompileInput): AgentPromptCompilation => {
  const diagnostics: AgentPromptDiagnostic[] = [];
  const files = normalizeFiles(input.files, diagnostics);
  const matchedRules = compileAgentRules({
    rules: input.rules ?? [],
    profile: input.profile,
    contextFiles: input.contextFiles ?? files,
  });
  diagnostics.push(...matchedRules.diagnostics);

  const nativeInstructions = [input.profile.instructions, matchedRules.content]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const envelopeWithoutText: Omit<AgentPortablePromptEnvelope, "text"> = {
    version: 1,
    profile: {
      id: input.profile.id,
      scope: input.profile.scope,
      revision: input.profile.revision,
    },
    instructions: input.profile.instructions,
    task: input.cleanTask,
    ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
    ...(input.context === undefined ? {} : { context: input.context }),
    files,
    rules: matchedRules.rules,
    ...(input.hookContext === undefined ? {} : { hookContext: input.hookContext }),
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    toolNames: [...new Set(input.toolNames ?? [])].sort(),
  };
  const text = renderPortablePrompt(envelopeWithoutText);
  const portablePrompt: AgentPortablePromptEnvelope = { ...envelopeWithoutText, text };

  return {
    nativeInstructions,
    portablePrompt,
    portablePromptEnvelope: portablePrompt,
    hashes: {
      profile: hash(stableJson(input.profile)),
      rules: hash(stableJson(matchedRules.rules)),
      task: hash(input.cleanTask),
      nativeInstructions: hash(nativeInstructions),
      portablePrompt: hash(stableJson(portablePrompt)),
    },
    diagnostics,
  };
};

export const compilePrompt = compileAgentPrompt;
