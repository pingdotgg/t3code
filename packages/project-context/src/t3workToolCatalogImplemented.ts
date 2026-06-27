import { EMPTY_OBJECT_INPUT_SCHEMA, type T3workToolCatalogEntry } from "./t3workToolCatalogCore.ts";
import {
  IMPLEMENTED_T3WORK_BACKLOG_TOOL_CATALOG,
  IMPLEMENTED_T3WORK_DRAFT_TOOL_CATALOG,
} from "./t3workToolCatalogImplementedDrafts.ts";

const START_CHILD_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      description: "Name for the new child session.",
      minLength: 1,
    },
    execution_scope: {
      type: "string",
      description:
        "Required execution scope. Use 'metarepo' for project planning, triage, and synthesis in the project workspace. Use 'repository' for implementation, debugging, tests, review, or PR work in a dedicated linked-repository worktree.",
      enum: ["metarepo", "repository"],
    },
    ticket_id: {
      type: "string",
      description:
        "Optional project ticket ID to attach the child session to. When this differs from the current ticket, the new session is attached directly under that ticket instead of nesting under the current thread.",
      minLength: 1,
    },
    kickoff_prompt: {
      type: "string",
      description: "Optional first prompt sent to the child session.",
      minLength: 1,
    },
    kickoff_mode: {
      type: "string",
      description:
        "Optional kickoff style. 'plan' maps to plan mode; 'interactive' and 'autopilot' currently map to the default interaction mode.",
      enum: ["plan", "interactive", "autopilot"],
    },
    model: {
      type: "string",
      description:
        "Optional canonical model slug override for the child session. Prefer omitting this to inherit the current thread model; if you set it, use a provider-specific canonical slug such as 'gpt-5.4' or 'gpt-5.3-codex', not a generic alias like 'gpt-5'.",
      minLength: 1,
    },
    reasoning_effort: {
      type: "string",
      description: "Optional reasoning effort override for the child session.",
      enum: ["low", "medium", "high"],
    },
    repo_full_name: {
      type: "string",
      description:
        "Required when execution_scope is 'repository' and forbidden when execution_scope is 'metarepo'. Linked repository to open in a fresh scoped worktree, for example 'owner/repo' or 'github.com/owner/repo'.",
      minLength: 1,
    },
    repo_ref: {
      type: "string",
      description:
        "Optional branch, tag, or commit to use as the base ref for the repository scoped worktree. Only valid when execution_scope is 'repository'. When omitted, the linked repository default branch is used.",
      minLength: 1,
    },
  },
  required: ["name", "execution_scope"],
} as const;

export const IMPLEMENTED_T3WORK_TOOL_CATALOG = {
  ...IMPLEMENTED_T3WORK_BACKLOG_TOOL_CATALOG,
  ...IMPLEMENTED_T3WORK_DRAFT_TOOL_CATALOG,
  "t3work.view.read": {
    id: "t3work.view.read",
    label: "Read view",
    title: "Read current t3work view",
    description: "Read the latest thread, project, and current t3work view context.",
    capabilities: ["read"],
    kind: "read",
    surfaces: ["thread"],
    status: "implemented",
    defaultEnabled: true,
    inputSchema: EMPTY_OBJECT_INPUT_SCHEMA,
  },
  "t3work.thread.rename": {
    id: "t3work.thread.rename",
    label: "Rename thread",
    title: "Rename current thread",
    description: "Rename the current thread in t3work.",
    capabilities: ["write"],
    kind: "thread",
    surfaces: ["thread"],
    status: "implemented",
    defaultEnabled: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          description: "New thread title.",
          minLength: 1,
        },
      },
      required: ["title"],
    },
  },
  "t3work.thread.start_child": {
    id: "t3work.thread.start_child",
    label: "Start child session",
    title: "Start child session",
    description:
      "Create a child t3work session from the current thread and optionally start it immediately. execution_scope is required: 'metarepo' stays in the project metarepo workspace without repo_full_name; 'repository' requires repo_full_name and prepares a dedicated scoped worktree for that linked repository.",
    capabilities: ["write"],
    kind: "thread",
    surfaces: ["thread"],
    status: "implemented",
    defaultEnabled: true,
    inputSchema: START_CHILD_INPUT_SCHEMA,
  },
} as const satisfies Record<string, T3workToolCatalogEntry>;
