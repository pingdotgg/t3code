import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProjectRecipeWorkflowDocument, RecipeSurface } from "@t3tools/project-recipes";
import { getBundledT3WorkRecipe } from "@t3tools/t3work-skill-packs";

import type { BackendApi } from "~/t3work/backend/t3work-types";
import { T3workInlineWorkflowPromptDialog } from "~/t3work/t3work-InlineWorkflowPromptDialog";
import { launchProjectDashboardBacklogDeterministicWorkflow } from "~/t3work/t3work-deterministicWorkflowLaunch";
import {
  createPendingT3workInlineWorkflowPrompt,
  type PendingT3workInlineWorkflowPrompt,
} from "~/t3work/t3work-inlineRecipeLaunchLocal";

export type T3workInlineRecipeLaunchOutcome = {
  readonly applied: boolean;
  readonly promptText?: string;
};

export type T3workDeterministicWorkflowLaunch = {
  readonly launchId: string;
  readonly title: string;
  readonly description: string;
  readonly surface: RecipeSurface;
  readonly workflow: ProjectRecipeWorkflowDocument;
  readonly parameters?: Record<string, unknown>;
  readonly allowedToolGroups?: ReadonlyArray<string>;
  readonly source?: "bundled" | "project-local";
};

type T3workInlineRecipeLaunchHandler = (
  launch: string | T3workDeterministicWorkflowLaunch,
) => Promise<T3workInlineRecipeLaunchOutcome | null>;

const T3workInlineRecipeLaunchContext = createContext<{
  registerHandler: (handler: T3workInlineRecipeLaunchHandler | null) => () => void;
  runLaunch: (recipeId: string) => Promise<T3workInlineRecipeLaunchOutcome | null>;
  runWorkflowLaunch: (
    launch: T3workDeterministicWorkflowLaunch,
  ) => Promise<T3workInlineRecipeLaunchOutcome | null>;
}>({
  registerHandler: () => () => undefined,
  runLaunch: async () => null,
  runWorkflowLaunch: async () => null,
});

export async function launchProjectDashboardBacklogInlineRecipe(input: {
  readonly backend: Pick<BackendApi, "launchRecipeWorkflow">;
  readonly recipeId: string;
  readonly workspaceRoot?: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly state: import("~/t3work/t3work-projectDashboardBacklogStateShared").ProjectDashboardBacklogState;
  readonly currentUserDisplayName: string | undefined;
  readonly setState: (
    nextState:
      | import("~/t3work/t3work-projectDashboardBacklogStateShared").ProjectDashboardBacklogState
      | ((
          current: import("~/t3work/t3work-projectDashboardBacklogStateShared").ProjectDashboardBacklogState,
        ) => import("~/t3work/t3work-projectDashboardBacklogStateShared").ProjectDashboardBacklogState),
  ) => void;
}): Promise<T3workInlineRecipeLaunchOutcome | null> {
  const recipe = getBundledT3WorkRecipe(input.recipeId);
  if (!recipe?.kickoff) {
    return null;
  }

  return launchProjectDashboardBacklogDeterministicWorkflow({
    backend: input.backend,
    launchId: recipe.id,
    title: recipe.title,
    description: recipe.shortDescription,
    surface: "project.dashboard.backlog",
    workflow: recipe.kickoff,
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    state: input.state,
    currentUserDisplayName: input.currentUserDisplayName,
    setState: input.setState,
    source: "bundled",
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(recipe.allowedToolGroups ? { allowedToolGroups: recipe.allowedToolGroups } : {}),
  });
}

export function T3workInlineRecipeLaunchProvider({ children }: { readonly children: ReactNode }) {
  const handlerRef = useRef<T3workInlineRecipeLaunchHandler | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<
    | (PendingT3workInlineWorkflowPrompt & {
        readonly resolve: (outcome: T3workInlineRecipeLaunchOutcome | null) => void;
      })
    | null
  >(null);
  const openLocalWorkflowPrompt = useCallback(
    (launch: T3workDeterministicWorkflowLaunch) => {
      const prompt = createPendingT3workInlineWorkflowPrompt(launch);
      if (!prompt || pendingPrompt) {
        return Promise.resolve(null);
      }

      return new Promise<T3workInlineRecipeLaunchOutcome | null>((resolve) => {
        setPendingPrompt({ ...prompt, resolve });
      });
    },
    [pendingPrompt],
  );
  const value = useMemo(
    () => ({
      registerHandler: (handler: T3workInlineRecipeLaunchHandler | null) => {
        handlerRef.current = handler;
        return () => {
          if (handlerRef.current === handler) {
            handlerRef.current = null;
          }
        };
      },
      runLaunch: (recipeId: string) => handlerRef.current?.(recipeId) ?? Promise.resolve(null),
      runWorkflowLaunch: async (launch: T3workDeterministicWorkflowLaunch) => {
        const handled = await (handlerRef.current?.(launch) ?? Promise.resolve(null));
        return handled ?? openLocalWorkflowPrompt(launch);
      },
    }),
    [openLocalWorkflowPrompt],
  );
  const resolvePrompt = useCallback((outcome: T3workInlineRecipeLaunchOutcome | null) => {
    setPendingPrompt((current) => {
      current?.resolve(outcome);
      return null;
    });
  }, []);

  return (
    <T3workInlineRecipeLaunchContext.Provider value={value}>
      {children}
      <T3workInlineWorkflowPromptDialog prompt={pendingPrompt} onResolve={resolvePrompt} />
    </T3workInlineRecipeLaunchContext.Provider>
  );
}

export function useRegisterT3workInlineRecipeLaunchHandler(
  handler: T3workInlineRecipeLaunchHandler | null,
) {
  const { registerHandler } = useContext(T3workInlineRecipeLaunchContext);
  useEffect(() => registerHandler(handler), [handler, registerHandler]);
}

export function useRunT3workInlineRecipeLaunch() {
  return useContext(T3workInlineRecipeLaunchContext).runLaunch;
}

export function useRunT3workDeterministicWorkflowLaunch() {
  return useContext(T3workInlineRecipeLaunchContext).runWorkflowLaunch;
}
