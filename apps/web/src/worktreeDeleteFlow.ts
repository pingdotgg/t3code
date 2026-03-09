import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import type { NativeApi } from "@t3tools/contracts";

import { cleanupProjectScript } from "./projectScripts";
import type { Project, Thread } from "./types";

interface DeleteThreadWorktreeInput {
  api: NativeApi;
  thread: Pick<Thread, "id">;
  project: Pick<Project, "cwd" | "scripts">;
  worktreePath: string;
  removeWorktree: (input: { cwd: string; path: string; force: boolean }) => Promise<void>;
}

export async function deleteThreadWorktree(
  input: DeleteThreadWorktreeInput,
): Promise<void> {
  const deleteHookScript = cleanupProjectScript(input.project.scripts);
  if (deleteHookScript) {
    await input.api.projects.runLifecycleScript({
      cwd: input.worktreePath,
      command: deleteHookScript.command,
      env: projectScriptRuntimeEnv({
        project: { cwd: input.project.cwd },
        worktreePath: input.worktreePath,
      }),
    });
  }

  try {
    await input.api.terminal.close({
      threadId: input.thread.id,
    });
  } catch {
    // Terminal may already be closed
  }

  await input.removeWorktree({
    cwd: input.project.cwd,
    path: input.worktreePath,
    force: true,
  });
}
