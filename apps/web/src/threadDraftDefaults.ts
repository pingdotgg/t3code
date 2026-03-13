import type { DraftThreadEnvMode } from "./composerDraftStore";

export interface NewThreadDraftDefaults {
  branch: string | null;
  worktreePath: null;
  envMode: DraftThreadEnvMode;
}

interface ThreadDraftDefaultsApi {
  git: {
    status: (input: { cwd: string }) => Promise<{ branch: string | null }>;
  };
}

export async function buildNewThreadDraftDefaults(input: {
  api: ThreadDraftDefaultsApi;
  projectCwd: string | null;
  preferNewWorktree: boolean;
  forceLocal?: boolean;
}): Promise<NewThreadDraftDefaults> {
  if (input.forceLocal === true || input.preferNewWorktree === false) {
    return {
      branch: null,
      worktreePath: null,
      envMode: "local",
    };
  }

  if (!input.projectCwd) {
    return {
      branch: null,
      worktreePath: null,
      envMode: "worktree",
    };
  }

  let status: { branch: string | null } | null = null;
  try {
    status = await input.api.git.status({ cwd: input.projectCwd });
  } catch {
    status = null;
  }

  return {
    branch: status?.branch ?? null,
    worktreePath: null,
    envMode: "worktree",
  };
}
