import type { EnvironmentId } from "@t3tools/contracts";

import { setMarkdownTaskChecked } from "./filePreviewMode";
import { getProjectFileQueryData, setProjectFileQueryData } from "./projectFilesQueryState";

export function changeMarkdownTask({
  environmentId,
  cwd,
  relativePath,
  readOnly,
  markerOffset,
  checked,
  change,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  readOnly: boolean;
  markerOffset: number;
  checked: boolean;
  change: (contents: string) => void;
}): void {
  if (readOnly) return;
  const file = getProjectFileQueryData(environmentId, cwd, relativePath);
  // Only a complete live read can authorize replacing the original file.
  if (!file || file.truncated) return;
  const nextContents = setMarkdownTaskChecked(file.contents, markerOffset, checked);
  if (nextContents === file.contents) return;
  setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
  change(nextContents);
}
