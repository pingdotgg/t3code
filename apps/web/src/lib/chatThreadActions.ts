import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  resolveProjectLastUsedSettings,
  type ProjectLastUsedSettings,
  type ProjectLastUsedSettingsThread,
} from "@t3tools/client-runtime/state/project-last-used-settings";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ScopedProjectRef,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
  type ResolvedProjectSettings,
} from "@t3tools/shared/projectSettings";
import {
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftId,
  type DraftThreadEnvMode,
} from "../composerDraftStore";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

/**
 * What a new thread in a project starts with when the draft has no pick of its
 * own: a setting configured on the project itself wins, then the project's
 * last user-used settings, then environment defaults. Only defaults give way
 * to the usage-limit fallback; a model the user last ran here is their pick.
 */
export function resolveNewThreadDefaults(input: {
  readonly projectId: ProjectId;
  readonly projectSettings: ResolvedProjectSettings;
  readonly lastUsed: ProjectLastUsedSettings | null;
  readonly serverSettings: ServerSettings | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly hasStickyProvider: boolean;
  readonly now: number;
}): {
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
} {
  const { settings, sources } = input.projectSettings;
  const runtimeMode =
    (sources.defaultRuntimeMode === "environment" ? input.lastUsed?.runtimeMode : null) ??
    settings.defaultRuntimeMode;
  const projectSelection =
    sources.defaultModelSelection === "environment" ? null : settings.defaultModelSelection;
  if (!projectSelection && input.lastUsed) {
    return { modelSelection: input.lastUsed.modelSelection, runtimeMode };
  }
  const defaultSelection = settings.defaultModelSelection ?? null;
  const resolution = resolveNewThreadModelSelection({
    defaultSelection:
      defaultSelection ??
      (input.hasStickyProvider || !input.serverSettings
        ? null
        : resolveProjectDefaultProviderModelSelection(
            input.providers,
            input.serverSettings,
            input.projectId,
          )),
    fallbackSelection: input.serverSettings?.fallbackModelSelection ?? null,
    providers: input.providers,
    ...(input.serverSettings ? { settings: input.serverSettings } : {}),
    projectId: input.projectId,
    now: input.now,
  });
  return {
    modelSelection: resolution.fallback ? resolution.selection : defaultSelection,
    runtimeMode,
  };
}

/**
 * Moves a draft that keeps its content to another project, or to the same
 * project on another machine. The draft session holds only defaults, since
 * the composer holds what the user picked and outranks it, so the session
 * takes the destination's defaults rather than keeping the source's.
 * A logical project key also remaps that project's draft to this one.
 */
export function retargetDraftToProject(input: {
  readonly draftId: DraftId;
  readonly projectRef: ScopedProjectRef;
  readonly project: LegacyProjectSettingsFields | null;
  readonly environmentSettings: ServerSettings | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly threads: ReadonlyArray<ProjectLastUsedSettingsThread>;
  readonly logicalProjectKey: string | null;
  readonly routing?: {
    readonly environmentSelection: "auto" | "manual";
    readonly loadBalancedEnvironmentId: EnvironmentId | null;
  };
  /** Automatic routing picked the machine for the current model, so it keeps that model. */
  readonly refreshModel: boolean;
}): void {
  const store = useComposerDraftStore.getState();
  const defaults = resolveNewThreadDefaults({
    projectId: input.projectRef.projectId,
    projectSettings: resolveProjectSettings(
      input.environmentSettings ?? DEFAULT_SERVER_SETTINGS,
      input.projectRef.projectId,
      input.project,
    ),
    lastUsed: resolveProjectLastUsedSettings(input.threads, input.projectRef),
    serverSettings: input.environmentSettings,
    providers: input.providers,
    hasStickyProvider: store.stickyActiveProvider !== null,
    now: Date.now(),
  });
  const context = {
    ...input.routing,
    runtimeMode: defaults.runtimeMode,
  };
  if (input.logicalProjectKey === null) {
    store.setDraftThreadContext(input.draftId, { projectRef: input.projectRef, ...context });
  } else {
    store.setLogicalProjectDraftThreadId(
      input.logicalProjectKey,
      input.projectRef,
      input.draftId,
      context,
    );
  }
  if (
    input.refreshModel &&
    !hasExplicitComposerModelSelection(store.getComposerDraft(input.draftId))
  ) {
    store.applyStickyState(input.draftId);
    if (defaults.modelSelection) {
      store.setModelSelection(input.draftId, defaults.modelSelection, { replaceOptions: true });
    }
  }
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
