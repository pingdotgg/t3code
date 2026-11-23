import { readWorkflowPane, type WorkflowPaneState } from "./workflowPane.logic";

export interface WorkflowsSearch extends WorkflowPaneState {
  readonly env?: string;
  readonly run?: string;
  /** Show the definition files instead of the runs: all of them, or `file` in the editor. */
  readonly definitions?: boolean;
  readonly file?: string;
}

export function workflowsSearchFromUrl(raw: Record<string, unknown>): WorkflowsSearch {
  return {
    ...(typeof raw.env === "string" && raw.env ? { env: raw.env.slice(0, 200) } : {}),
    ...(typeof raw.run === "string" && raw.run ? { run: raw.run.slice(0, 200) } : {}),
    ...readWorkflowPane(raw.pane, raw.tab),
    ...(raw.definitions === true || raw.definitions === "true" ? { definitions: true } : {}),
    ...(typeof raw.file === "string" && raw.file ? { file: raw.file.slice(0, 200) } : {}),
  };
}
