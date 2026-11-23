import type { EnvironmentId } from "@t3tools/contracts";

export interface SandboxProjectInput {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly workingDirectory: string;
}

export interface SandboxProjectDependencies {
  readonly hasProjectAt: (environmentId: EnvironmentId, workspaceRoot: string) => boolean;
  /** Resolves with an error message, or null once the project exists. */
  readonly createProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly title: string;
    readonly workspaceRoot: string;
  }) => Promise<string | null>;
}

/**
 * Gives a Sandbox its one project: its working directory, named after the
 * Agent, where agentctl Sessions start too. The server allows one project per
 * folder, so a create racing another window's fails, and finds the project
 * there afterwards. Resolves with an error message, or null once it exists.
 */
export async function ensureSandboxProject(
  dependencies: SandboxProjectDependencies,
  input: SandboxProjectInput,
): Promise<string | null> {
  const exists = () => dependencies.hasProjectAt(input.environmentId, input.workingDirectory);
  if (exists()) return null;
  const error = await dependencies.createProject({
    environmentId: input.environmentId,
    title: input.name,
    workspaceRoot: input.workingDirectory,
  });
  return error === null || exists() ? null : error;
}
