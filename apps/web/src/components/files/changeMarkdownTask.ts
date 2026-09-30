import type { EnvironmentId } from "@t3tools/contracts";

import { setMarkdownTaskChecked } from "./filePreviewMode";
import { getProjectFileQueryData, setProjectFileQueryData } from "./projectFilesQueryState";

export function changeMarkdownTask({
  environmentId,
  cwd,
  relativePath,
  readOnly,
  contents,
  markerOffset,
  checked,
  change,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  readOnly: boolean;
  contents: string;
  markerOffset: number;
  checked: boolean;
  change: (contents: string) => void;
}): void {
  if (readOnly) return;
  const file = getProjectFileQueryData(environmentId, cwd, relativePath);
  // The marker offset belongs to the displayed snapshot, not a later refresh.
  // Only a complete live read of that snapshot can authorize replacement.
  if (!file || file.truncated || file.contents !== contents) return;
  const nextContents = setMarkdownTaskChecked(file.contents, markerOffset, checked);
  if (nextContents === file.contents) return;
  setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
  change(nextContents);
}
