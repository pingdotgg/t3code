import {
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import {
  isMultiRepoWorkspace,
  type ThreadWorkspace,
  WorkspaceRepositories,
} from "../workspace/WorkspaceRepositories.ts";
import { TaskFolderStore } from "../workspace/TaskFolders.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

/**
 * A turn would start in a mode above the policy's ceiling. The orchestrator refuses those when
 * they are dispatched; this catches the ones it never saw, such as a run resumed after a restart
 * on a thread whose mode predates the policy.
 */
export class RuntimePolicyAboveCeilingError extends Schema.TaggedError<RuntimePolicyAboveCeilingError>()(
  "RuntimePolicyAboveCeilingError",
  {
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    return `${managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode)} Switch this thread's mode to continue.`;
  }
}

export const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyAboveCeilingError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    });
  }),
});

function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

const refuseAboveCeiling = (
  managedPolicy: ServerSettings.ServerSettingsService["Service"]["managedPolicy"],
  thread: OrchestrationV2AppThread,
) => {
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return managedPolicy !== undefined &&
    maxRuntimeMode !== undefined &&
    isRuntimeModeAbove(thread.runtimeMode, maxRuntimeMode)
    ? Effect.fail(
        new RuntimePolicyAboveCeilingError({
          threadId: thread.id,
          runtimeMode: thread.runtimeMode,
          maxRuntimeMode,
          organization: managedPolicy.organization,
        }),
      )
    : Effect.void;
};

/** Lays the policy's ceiling over another runtime policy, as `layerFromProjectStore` does. */
export const layerEnforcingCeiling: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveWithinCeiling")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        return yield* base.resolve(input);
      }),
    });
  }),
);
/** The repos and references a provider sees. Undefined keeps single-repo policies unchanged. */
function runtimeWorkspace(
  path: Path.Path,
  cwd: string,
  workspace: ThreadWorkspace,
): ProviderAdapter.ProviderAdapterV2RuntimeWorkspace | undefined {
  if (!isMultiRepoWorkspace(workspace)) return undefined;
  const taskRoot = workspace.taskFolder?.root;
  const home = workspace.repositories.find((repository) => repository.kind === "home");
  return {
    repositories: workspace.repositories.map((repository) => ({
      name: repository.name,
      // Instructions match the policy cwd by string to mark the agent's working directory.
      path: path.resolve(repository.cwd) === path.resolve(cwd) ? cwd : repository.cwd,
    })),
    referenceFolders: workspace.references.map((reference) => ({
      name: reference.name,
      path: reference.path,
    })),
    extraRoots: workspace.repositories
      .map((repository) => repository.cwd)
      .filter(
        (root) =>
          !isWithinRoot(path, root, cwd) &&
          // A task folder thread must never write to the original checkouts.
          (taskRoot === undefined || isWithinRoot(path, root, taskRoot)),
      ),
    relativePathsDiffer:
      workspace.taskFolder !== null &&
      home !== undefined &&
      workspace.repositories.some(
        (repository) =>
          repository.kind === "repository" &&
          path.relative(home.originalPath, repository.originalPath).split(path.sep).join("/") !==
            repository.relativePath,
      ),
  };
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
  | WorkspaceRepositories
  | Path.Path
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // The same ceiling the orchestrator enforces, fixed for the server's life.
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
    const workspaceRepositories = yield* WorkspaceRepositories;
    const taskFolders = yield* Effect.serviceOption(TaskFolderStore);
    const path = yield* Path.Path;
    // A task folder keeps its repos even after the project stops tracking them.
    const inTaskFolder = (worktreePath: string | null) =>
      worktreePath === null || Option.isNone(taskFolders)
        ? Effect.succeed(false)
        : taskFolders.value.findContaining(path.resolve(worktreePath)).pipe(
            Effect.map(Option.isSome),
            Effect.orElseSucceed(() => false),
          );
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const resolveError = (cause: unknown) =>
          new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          });
        const projectLookup = projects
          .get(input.thread.projectId)
          .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(resolveError));
        const project =
          input.thread.worktreePath === null
            ? yield* projectLookup
            : // A worktree thread needs the project only to find its other repos.
              yield* projectLookup.pipe(Effect.orElseSucceed(() => undefined));
        const cwd = input.thread.worktreePath ?? project?.workspaceRoot;
        if (cwd === undefined) return yield* resolveError("Project not found.");
        // Projects without tracked folders skip the Git detection the lookup runs.
        const workspace =
          project === undefined ||
          (project.trackedFolders.length === 0 && !(yield* inTaskFolder(input.thread.worktreePath)))
            ? undefined
            : yield* workspaceRepositories
                .resolveThreadWorkspace({
                  projectId: input.thread.projectId,
                  worktreePath: input.thread.worktreePath,
                })
                .pipe(
                  Effect.map((resolved) => runtimeWorkspace(path, cwd, resolved)),
                  // The turn can still run in its own cwd, as a single-repo thread does.
                  Effect.catch((cause) =>
                    Effect.logWarning("Could not resolve the thread's repositories.", cause).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                );
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
          ...(workspace === undefined ? {} : { workspace }),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
