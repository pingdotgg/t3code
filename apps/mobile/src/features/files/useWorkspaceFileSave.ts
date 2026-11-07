import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useId, useState } from "react";

import { useFileChipShare } from "../threads/useFileChipShare";
import { resolveWorkspaceFilePath } from "./filePath";

export function useWorkspaceFileSave(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
}) {
  const sourceIdentifier = useId();
  const shareFile = useFileChipShare(input.environmentId, input.threadId, sourceIdentifier, {
    draftCwd: input.cwd,
    failureTitle: "Could not save file",
  });
  const [saving, setSaving] = useState(false);

  const save = () => {
    const { cwd, relativePath } = input;
    if (cwd === null || relativePath === null || saving) return;
    setSaving(true);
    void shareFile({
      fullPath: resolveWorkspaceFilePath(cwd, relativePath),
      relativePath,
    }).finally(() => setSaving(false));
  };

  return { save, saving };
}
