import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useCallback, useId, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";

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
  const scope = JSON.stringify([
    input.environmentId,
    input.threadId,
    input.cwd,
    input.relativePath,
  ]);
  const savingRef = useRef<{ scope: string } | null>(null);
  const [savingAttempt, setSavingAttempt] = useState<{ scope: string } | null>(null);
  const saving = savingAttempt?.scope === scope;
  useFocusEffect(
    useCallback(
      () => () => {
        if (savingRef.current?.scope === scope) {
          savingRef.current = null;
          setSavingAttempt(null);
        }
      },
      [scope],
    ),
  );

  const save = () => {
    const { cwd, relativePath } = input;
    if (cwd === null || relativePath === null || savingRef.current?.scope === scope) return;
    const attempt = { scope };
    savingRef.current = attempt;
    setSavingAttempt(attempt);
    void shareFile({
      fullPath: resolveWorkspaceFilePath(cwd, relativePath),
      relativePath,
    }).finally(() => {
      if (savingRef.current === attempt) {
        savingRef.current = null;
        setSavingAttempt(null);
      }
    });
  };

  return { save, saving };
}
