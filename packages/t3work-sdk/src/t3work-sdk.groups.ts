import "./t3work-sdk.globals.ts";

import { defineToolGroup } from "./t3work-sdk.ts";

export const githubRead = defineToolGroup({
  id: "github.read",
  label: "Read GitHub data",
  description:
    "View pull requests, issues, branches, commits, and files without mutating GitHub state.",
});

/**
 * Keep GitHub read and write scopes separate so workflow permission prompts can stay least-privilege by default.
 */
export const githubWrite = defineToolGroup({
  id: "github.write",
  label: "Modify GitHub",
  description:
    "Merge pull requests, push branches, edit issues, and trigger write-side GitHub actions.",
});

export const jiraRead = defineToolGroup({
  id: "jira.read",
  label: "Read Jira data",
  description:
    "View Jira issues, comments, fields, and project metadata without changing Jira state.",
});

export const jiraWrite = defineToolGroup({
  id: "jira.write",
  label: "Modify Jira",
  description: "Edit Jira issues, add comments, transition workflow state, and update assignments.",
});

export const t3workThreadWrite = defineToolGroup({
  id: "t3work.thread.write",
  label: "Modify t3work threads",
  description: "Rename threads, send workflow thread messages, and create child workflow threads.",
});

export const releaseNotesWrite = defineToolGroup({
  id: "release-notes.write",
  label: "Write release notes artifacts",
  description: "Create or update release notes content and related project artifacts.",
});

export const builtinToolGroups = [
  githubRead,
  githubWrite,
  jiraRead,
  jiraWrite,
  t3workThreadWrite,
  releaseNotesWrite,
] as const;
