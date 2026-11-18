import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useId, useRef, useState } from "react";

import { useFileChipShare } from "../threads/useFileChipShare";
import { resolveWorkspaceFilePath } from "./filePath";

export function useWorkspaceFileSave(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
}) {
  const gt = useGT();
  const sourceIdentifier = useId();
  const shareFile = useFileChipShare(input.environmentId, input.threadId, sourceIdentifier, {
    draftCwd: input.cwd,
    filePath: input.relativePath,
    failureTitle: gt("Could not save file"),
  });
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  const save = () => {
    const { cwd, relativePath } = input;
    if (cwd === null || relativePath === null || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    void shareFile({
      fullPath: resolveWorkspaceFilePath(cwd, relativePath),
      relativePath,
    }).finally(() => {
      savingRef.current = false;
      setSaving(false);
    });
  };

  return { save, saving };
}
