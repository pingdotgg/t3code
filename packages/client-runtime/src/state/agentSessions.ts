import {
  AgentSessionHistoryResult,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type EnvironmentId,
  type ProjectId,
  AgentSessionPreviewResult,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { CreateProjectInput } from "../operations/commands.ts";
import type { EnvironmentProject } from "./models.ts";
import type { AtomCommandResult } from "./runtime.ts";
import { persistQuery } from "./queryPersistence.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createAgentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    scan: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-sessions:scan",
      tag: WS_METHODS.agentSessionsScan,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-sessions:history",
      tag: WS_METHODS.agentSessionsHistory,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
      persistence: persistQuery(AgentSessionHistoryResult),
    }),
    preview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-sessions:preview",
      tag: WS_METHODS.agentSessionsPreview,
      staleTimeMs: 3_000,
      idleTtlMs: 0,
      persistence: persistQuery(AgentSessionPreviewResult),
    }),
    livePreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-sessions:live-preview",
      tag: WS_METHODS.agentSessionsPreview,
      staleTimeMs: 3_000,
      idleTtlMs: 0,
      refreshIntervalMs: 3_000,
    }),
    importSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-sessions:import",
      tag: WS_METHODS.agentSessionsImport,
    }),
    generateRecap: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-sessions:recap",
      tag: WS_METHODS.agentSessionsRecap,
    }),
  };
}

export async function continueAgentSession(options: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly session: AgentSessionImportInput["session"];
  readonly projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "workspaceRoot">>;
  readonly newProjectId: () => ProjectId;
  readonly isMounted: () => boolean;
  readonly createProject: (input: {
    environmentId: EnvironmentId;
    input: CreateProjectInput;
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly importSession: (input: {
    environmentId: EnvironmentId;
    input: AgentSessionImportInput;
  }) => Promise<AtomCommandResult<AgentSessionImportResult, unknown>>;
}) {
  const { environmentId, workspaceRoot } = options;
  let projectId = options.projects.find((project) => project.workspaceRoot === workspaceRoot)?.id;
  if (projectId === undefined) {
    projectId = options.newProjectId();
    const created = await options.createProject({
      environmentId,
      input: {
        projectId,
        title: workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project",
        workspaceRoot,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: null,
      },
    });
    if (!options.isMounted()) return { status: "cancelled" } as const;
    if (created._tag !== "Success") return { status: "project-error" } as const;
  }
  const imported = await options.importSession({
    environmentId,
    input: { projectId, expectedWorkspaceRoot: workspaceRoot, session: options.session },
  });
  if (!options.isMounted()) return { status: "cancelled" } as const;
  if (imported._tag !== "Success" || imported.value.threadId === undefined) {
    return { status: "import-error" } as const;
  }
  return { status: "ready", threadId: imported.value.threadId } as const;
}
