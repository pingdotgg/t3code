import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Reveal (select) an absolute path in the file manager of the environment's
 * host — Explorer on Windows, Finder on macOS, the containing directory on
 * Linux.
 */
export function useRevealInFileManager() {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, "reveal in file manager");
  return useCallback(
    (environmentId: EnvironmentId, targetPath: string) =>
      void openInEditor({
        environmentId,
        input: { cwd: targetPath, editor: "file-manager", reveal: true },
      }),
    [openInEditor],
  );
}
