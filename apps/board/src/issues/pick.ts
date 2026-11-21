import type { IssueListEntry, IssueRef } from "@t3tools/contracts";

export type PickerMode = "github" | "linear";

export interface PickerValue {
  readonly mode: PickerMode;
  readonly text: string;
  readonly source: IssueListEntry | null;
}

export const entryRef = ({ projectId, tracker, host, scope, key }: IssueListEntry): IssueRef => ({
  projectId,
  tracker,
  host,
  scope,
  key,
});
