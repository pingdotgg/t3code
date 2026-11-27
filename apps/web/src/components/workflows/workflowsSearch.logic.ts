import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import { readWorkflowPane, type WorkflowPaneState } from "./workflowPane.logic";

export interface WorkflowsSearch extends WorkflowPaneState {
  readonly env?: string;
  readonly run?: string;
  /** Show the definition files instead of the runs: all of them, or `file` in the editor. */
  readonly definitions?: boolean;
  readonly file?: string;
}

const sliceParam = (value: string) => value.slice(0, splitsSurrogatePair(value, 200) ? 199 : 200);

export function workflowsSearchFromUrl(raw: Record<string, unknown>): WorkflowsSearch {
  return {
    ...(typeof raw.env === "string" && raw.env ? { env: sliceParam(raw.env) } : {}),
    ...(typeof raw.run === "string" && raw.run ? { run: sliceParam(raw.run) } : {}),
    ...readWorkflowPane(raw.pane, raw.tab),
    ...(raw.definitions === true || raw.definitions === "true" ? { definitions: true } : {}),
    ...(typeof raw.file === "string" && raw.file ? { file: sliceParam(raw.file) } : {}),
  };
}
