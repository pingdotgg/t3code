/**
 * Shared selector-draft helpers used by SourceWizard (multi-step dialog).
 * Keeping them here makes them easy to reuse if additional consumers are added
 * and prevents provider selector shapes from drifting.
 */

import type { WorkflowSourceConfig } from "@t3tools/contracts/workSource";

// ─── types ───────────────────────────────────────────────────────────────────

export interface GithubSelectorDraft {
  owner: string;
  repo: string;
  /** Comma-separated label names as the user typed them. */
  labels: string;
  assignee: string;
  state: "all" | "open";
}

export interface AsanaSelectorDraft {
  projectGid: string;
  includeCompleted: boolean;
}

export interface JiraSelectorDraft {
  projectKey: string;
  jql: string;
}

export type SelectorDraft =
  | { provider: "github"; github: GithubSelectorDraft }
  | { provider: "asana"; asana: AsanaSelectorDraft }
  | { provider: "jira"; jira: JiraSelectorDraft };

// ─── defaults ────────────────────────────────────────────────────────────────

export function defaultGithubSelector(): GithubSelectorDraft {
  return { owner: "", repo: "", labels: "", assignee: "", state: "all" };
}

export function defaultAsanaSelector(): AsanaSelectorDraft {
  return { projectGid: "", includeCompleted: true };
}

export function defaultJiraSelector(): JiraSelectorDraft {
  return { projectKey: "", jql: "" };
}

// ─── encode ──────────────────────────────────────────────────────────────────

/** Convert a UI draft into the raw JSON stored in WorkflowSourceConfig.selector. */
export function encodeSelector(draft: SelectorDraft): unknown {
  if (draft.provider === "github") {
    const d = draft.github;
    return {
      owner: d.owner,
      repo: d.repo,
      ...(d.labels.trim()
        ? {
            labels: d.labels
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
      ...(d.assignee.trim() ? { assignee: d.assignee.trim() } : {}),
      state: d.state,
    };
  }
  if (draft.provider === "jira") {
    const d = draft.jira;
    return {
      projectKey: d.projectKey.trim(),
      ...(d.jql.trim() ? { jql: d.jql.trim() } : {}),
    };
  }
  const d = draft.asana;
  return { projectGid: d.projectGid, includeCompleted: d.includeCompleted };
}

// ─── decode ──────────────────────────────────────────────────────────────────

/**
 * Reconstruct a UI SelectorDraft from a persisted WorkflowSourceConfig.
 * `WorkflowSourceConfig` and the `SourceEncoded` alias used in SourcesSection
 * (`NonNullable<WorkflowDefinitionEncoded["sources"]>[number]`) are
 * structurally identical — they share the same Zod/Effect schema — so a
 * single function covers both callers.
 */
export function decodeSelectorDraft(
  source: Pick<WorkflowSourceConfig, "provider" | "selector">,
): SelectorDraft {
  const raw = source.selector as Record<string, unknown> | null | undefined;
  if (source.provider === "github") {
    const labelsRaw = Array.isArray(raw?.["labels"]) ? (raw["labels"] as string[]).join(", ") : "";
    return {
      provider: "github",
      github: {
        owner: typeof raw?.["owner"] === "string" ? raw["owner"] : "",
        repo: typeof raw?.["repo"] === "string" ? raw["repo"] : "",
        labels: labelsRaw,
        assignee: typeof raw?.["assignee"] === "string" ? raw["assignee"] : "",
        state: raw?.["state"] === "open" ? "open" : "all",
      },
    };
  }
  if (source.provider === "jira") {
    return {
      provider: "jira",
      jira: {
        projectKey: typeof raw?.["projectKey"] === "string" ? raw["projectKey"] : "",
        jql: typeof raw?.["jql"] === "string" ? raw["jql"] : "",
      },
    };
  }
  return {
    provider: "asana",
    asana: {
      projectGid: typeof raw?.["projectGid"] === "string" ? raw["projectGid"] : "",
      includeCompleted:
        typeof raw?.["includeCompleted"] === "boolean" ? raw["includeCompleted"] : true,
    },
  };
}
