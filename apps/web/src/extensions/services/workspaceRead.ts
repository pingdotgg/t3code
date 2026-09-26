import type {
  OrchestrationShellSnapshot,
  ProjectReadFileInput,
  ProjectReadFileResult,
} from "@t3tools/contracts";
import {
  copyJson,
  MAX_PAYLOAD_BYTES,
  validateContext,
  type ViewContext,
} from "@t3tools/extension-sdk/contracts";
import type { HostOptions, HostService } from "@t3tools/extension-sdk/host";

export const WORKSPACE_READ_TEXT = "t3.workspace/read-text";
export interface WorkspaceReadTarget {
  readonly cwd: string;
  readonly revision: string;
}
export interface WorkspaceReadDependencies {
  /** Resolve only live, host-owned project membership; never trust a renderer-supplied cwd. */
  resolve(context: ViewContext): WorkspaceReadTarget;
  read(
    environmentId: string,
    input: ProjectReadFileInput,
    signal: AbortSignal,
  ): Promise<ProjectReadFileResult>;
}

/** A host snapshot establishes membership; resource fields alone are not authorization. */
export function resolveWorkspaceReadTarget(
  snapshot: {
    readonly projects: readonly Pick<
      OrchestrationShellSnapshot["projects"][number],
      "id" | "workspaceRoot"
    >[];
    readonly threads: readonly Pick<
      OrchestrationShellSnapshot["threads"][number],
      "id" | "projectId" | "worktreePath"
    >[];
  },
  context: ViewContext,
): WorkspaceReadTarget {
  const project = snapshot.projects.find((item) => item.id === context.resource.projectId);
  if (!project) throw new Error("Workspace project is unavailable");
  const threadId = context.resource.threadId;
  const thread = threadId ? snapshot.threads.find((item) => item.id === threadId) : undefined;
  if (threadId && (!thread || thread.projectId !== project.id))
    throw new Error("Thread does not belong to workspace project");
  const cwd = thread?.worktreePath ?? project.workspaceRoot;
  return { cwd, revision: JSON.stringify([project.workspaceRoot, thread?.worktreePath ?? null]) };
}

function relativePath(input: unknown): string {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !("relativePath" in input) ||
    typeof input.relativePath !== "string"
  )
    throw new Error("Expected a workspace-relative path");
  const path = input.relativePath;
  if (
    !path ||
    path !== path.trim() ||
    path.length > 1024 ||
    /[\\:]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Expected a workspace-relative path using forward slashes");
  return path;
}

/** Bound the complete encoded response, including escaped text and metadata. */
export function boundedWorkspaceText(result: ProjectReadFileResult, path: string) {
  if (
    result.relativePath !== path ||
    typeof result.contents !== "string" ||
    !Number.isSafeInteger(result.byteLength) ||
    result.byteLength < 0 ||
    typeof result.truncated !== "boolean"
  )
    throw new Error("Invalid workspace read response");
  const make = (length: number) => {
    let contents = result.contents.slice(0, length);
    if (length < result.contents.length && /[\uD800-\uDBFF]$/.test(contents))
      contents = contents.slice(0, -1);
    return {
      relativePath: path,
      contents,
      byteLength: result.byteLength,
      truncated: result.truncated || contents.length < result.contents.length,
    };
  };
  let low = 0,
    high = Math.min(result.contents.length, MAX_PAYLOAD_BYTES);
  copyJson(make(0));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    try {
      copyJson(make(middle));
      low = middle;
    } catch {
      high = middle - 1;
    }
  }
  return copyJson(make(low));
}

/** Trusted client adapter; existing authenticated RPC retains filesystem enforcement. */
export function createWorkspaceReadService(dependencies: WorkspaceReadDependencies): HostService {
  return {
    capability: WORKSPACE_READ_TEXT,
    async invoke(call) {
      const context = validateContext(call.context);
      if (!context.resource.projectId) throw new Error("Workspace read requires project scope");
      const path = relativePath(call.input);
      call.signal.throwIfAborted();
      const target = dependencies.resolve(context);
      if (context.workspaceRevision !== undefined && context.workspaceRevision !== target.revision)
        throw new Error("Workspace revision changed");
      const result = await dependencies.read(
        context.resource.environmentId,
        { cwd: target.cwd, relativePath: path },
        call.signal,
      );
      call.signal.throwIfAborted();
      const current = dependencies.resolve(context);
      if (current.cwd !== target.cwd || current.revision !== target.revision)
        throw new Error("Workspace changed during read");
      return boundedWorkspaceText(result, path);
    },
  };
}

/** Explicit installation grant. Revocation is checked by the SDK on every invocation. */
export function workspaceReadHostOptions(
  dependencies: WorkspaceReadDependencies,
  grant: {
    readonly extensionId: string;
    readonly environmentId: string;
    readonly projectId: string;
    readonly isEnabled: () => boolean;
  },
): HostOptions {
  const installed = { ...grant };
  const authorize: HostOptions["authorize"] = (extensionId, capability, context) =>
    installed.isEnabled() &&
    extensionId === installed.extensionId &&
    capability === WORKSPACE_READ_TEXT &&
    context.resource.environmentId === installed.environmentId &&
    context.resource.projectId === installed.projectId;
  const service = createWorkspaceReadService(dependencies);
  return {
    authorize,
    services: [
      {
        capability: service.capability,
        async invoke(call) {
          if (!authorize(call.extensionId, service.capability, call.context))
            throw new Error("Capability denied");
          const result = await service.invoke(call);
          if (!authorize(call.extensionId, service.capability, call.context))
            throw new Error("Capability revoked during read");
          return result;
        },
      },
    ],
  };
}
