import {
  type EnvRecord,
  isManagedRuntimeEnvKey,
  stripManagedRuntimeEnvKeys,
} from "@t3tools/shared/projectLaunchEnv";

export type { EnvRecord };
export { isManagedRuntimeEnvKey, stripManagedRuntimeEnvKeys };

export interface ProjectLaunchEnvContextInput {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly worktreePath?: string | null | undefined;
}

export function buildLaunchContextEnv(input: ProjectLaunchEnvContextInput): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.projectRoot,
    T3CODE_PROJECT_ID: input.projectId,
    T3CODE_THREAD_ID: input.threadId,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  return env;
}

export function mergeResolvedProjectLaunchEnv(input: {
  readonly t3Home: string;
  readonly extraEnv?: EnvRecord;
  readonly context: ProjectLaunchEnvContextInput;
}): Record<string, string> {
  return {
    ...stripManagedRuntimeEnvKeys(input.extraEnv),
    T3CODE_HOME: input.t3Home,
    ...buildLaunchContextEnv(input.context),
  };
}
