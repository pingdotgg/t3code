import { useEffect, useMemo, useState } from "react";
import { matchRecipes } from "@t3tools/project-recipes";
import {
  getBundledT3WorkRecipe,
  getT3WorkProfile,
  listBundledT3WorkRecipes,
  resolveEnabledSkillPackIds,
  toRecipeProfileContext,
} from "@t3tools/t3work-skill-packs";

import type { BackendApi } from "~/t3work/backend/t3work-types";
import { buildT3workActionRecipeLaunchContext } from "~/t3work/t3work-actionRecipeLaunchContext";
import { buildAvailableContextKeys } from "~/t3work/t3work-sidecarRecipeContextKeys";
import {
  buildPinnedQuickStartSelection,
  mergeSidecarRecipeQuickStarts,
  mapDiscoveredRecipesToQuickStarts,
} from "~/t3work/t3work-sidecarRecipeDiscoveryMapping";
import {
  buildProjectRecipeDiscoveryRequest,
  buildRecipeRenderContext,
} from "~/t3work/t3work-sidecarRecipeRenderContext";
import {
  buildBundledRecipeTemplateValues,
  renderPromptTemplate,
} from "~/t3work/t3work-sidecarRecipeTemplates";
import { areQuickStartsEqual } from "~/t3work/t3work-sidecarRecipeQuickStartEquality";
import type {
  T3workSidecarRecipeInput,
  T3workSidecarRecipeQuickStart,
} from "~/t3work/t3work-sidecarRecipeTypes";

export type {
  T3workRecipeComposerGuidance,
  T3workSidecarRecipeActionView,
  T3workSidecarRecipeLinkedResource,
  T3workSidecarRecipeQuickStart,
  T3workSidecarRecipeTicketContext,
  T3workSidecarRecipeTicketGitHubSummary,
  T3workSidecarRecipeTicketRelationships,
} from "~/t3work/t3work-sidecarRecipeTypes";

export { buildProjectRecipeDiscoveryRequest } from "~/t3work/t3work-sidecarRecipeRenderContext";

export function buildT3workSidecarRecipeQuickStarts(
  input: T3workSidecarRecipeInput,
): ReadonlyArray<T3workSidecarRecipeQuickStart> {
  const profile = getT3WorkProfile(input.profileId);
  const enabledSkillPacks = resolveEnabledSkillPackIds({ profile });
  const renderContext = buildRecipeRenderContext(input, profile);
  const resolvedSurface = renderContext.surface;
  const projectWorkspaceRoot = input.project.workspace?.rootPath;
  const availableContextKeys = buildAvailableContextKeys(input);
  const templateValues = buildBundledRecipeTemplateValues(input);
  const launchContext = buildT3workActionRecipeLaunchContext(renderContext);
  const matches = matchRecipes(listBundledT3WorkRecipes(), {
    activeProject: input.project,
    selectedResource: null,
    resourceKind: input.resourceKind ?? null,
    availableIntegrations: [
      ...new Set([input.project.source.provider, ...(input.availableIntegrations ?? [])]),
    ],
    surface: resolvedSurface,
    ...(input.jiraIssueType ? { jiraIssueType: input.jiraIssueType } : {}),
    enabledSkillPacks,
    profile: toRecipeProfileContext(profile),
    availableContextKeys,
  }).filter((result) => result.missingContext.length === 0);

  return buildPinnedQuickStartSelection(matches, input.limit ?? 5).map((result) => {
    const bundledRecipe = getBundledT3WorkRecipe(result.recipe.id);
    const localBundledRecipePath =
      result.recipe.id === "create-recipe" && projectWorkspaceRoot
        ? `${projectWorkspaceRoot}/.t3work/recipes/create-recipe`
        : undefined;
    const renderedTitle = renderPromptTemplate(
      bundledRecipe?.manifestDisplayName ?? result.recipe.title,
      templateValues,
    );
    const renderedDescription = renderPromptTemplate(
      result.recipe.shortDescription,
      templateValues,
    );
    const renderedPrompt = renderPromptTemplate(
      result.recipe.promptTemplate ?? result.recipe.shortDescription,
      templateValues,
    );

    const quickStart: T3workSidecarRecipeQuickStart = {
      id: result.recipe.id,
      title: renderedTitle,
      description: renderedDescription,
      prompt: renderedPrompt,
      workflow: {
        kind: "recipe",
        recipeId: result.recipe.id,
        ...(bundledRecipe?.version ? { recipeVersion: bundledRecipe.version } : {}),
        ...(result.recipe.kickoff ? { kickoff: result.recipe.kickoff } : {}),
        title: renderedTitle,
        description: renderedDescription,
        source: "bundled",
        surface: resolvedSurface,
        reason: result.reason,
        launchContext,
        ...(localBundledRecipePath ? { recipePath: localBundledRecipePath } : {}),
        ...(localBundledRecipePath
          ? { workflowPath: `${localBundledRecipePath}/workflow.ts` }
          : {}),
        ...(bundledRecipe?.allowedToolGroups
          ? { allowedToolGroups: bundledRecipe.allowedToolGroups }
          : {}),
      },
    };

    if (bundledRecipe?.composerGuidance) {
      Object.assign(quickStart, {
        composerGuidance: bundledRecipe.composerGuidance,
      });
    }

    return bundledRecipe?.actionViewTemplate
      ? Object.assign(quickStart, {
          actionView: {
            source: renderPromptTemplate(bundledRecipe.actionViewTemplate, templateValues),
            context: renderContext,
          },
        })
      : quickStart;
  });
}

export function useT3workSidecarRecipeQuickStarts(
  input: T3workSidecarRecipeInput & {
    readonly backend: BackendApi | null;
  },
): ReadonlyArray<T3workSidecarRecipeQuickStart> {
  const fallbackQuickStarts = useMemo(() => buildT3workSidecarRecipeQuickStarts(input), [input]);
  const [quickStarts, setQuickStarts] =
    useState<ReadonlyArray<T3workSidecarRecipeQuickStart>>(fallbackQuickStarts);
  const workspaceRoot = input.project.workspace?.rootPath;
  const availableContextKey = (input.availableContextKeys ?? []).join("\u0000");
  const availableIntegrationsKey = (input.availableIntegrations ?? []).join("\u0000");
  const contextAttachmentsKey = (input.contextAttachments ?? [])
    .map((attachment) =>
      [attachment.id, attachment.kind, attachment.label, attachment.jiraIssueType ?? ""].join(
        "\u0001",
      ),
    )
    .join("\u0000");
  const linkedResourcesKey = JSON.stringify(input.linkedResources ?? []);
  const ticketContextKey = JSON.stringify(input.ticketContext ?? null);

  useEffect(() => {
    const setQuickStartsIfChanged = (
      nextQuickStarts: ReadonlyArray<T3workSidecarRecipeQuickStart>,
    ) => {
      setQuickStarts((current) =>
        areQuickStartsEqual(current, nextQuickStarts) ? current : nextQuickStarts,
      );
    };

    setQuickStartsIfChanged(fallbackQuickStarts);

    if (!input.backend || !workspaceRoot) {
      return;
    }

    const discoveryRequest = buildProjectRecipeDiscoveryRequest({
      ...input,
      workspaceRoot,
    });
    let cancelled = false;
    void input.backend.projectWorkspace
      .discoverRecipes(discoveryRequest)
      .then((response) => {
        if (cancelled) {
          return;
        }
        if (!response.hasProjectLocalRecipes) {
          setQuickStartsIfChanged(fallbackQuickStarts);
          return;
        }
        const discoveredQuickStarts = mapDiscoveredRecipesToQuickStarts(
          response.recipes,
          discoveryRequest.context.surface,
          input.limit,
          discoveryRequest.context,
        );
        setQuickStartsIfChanged(
          mergeSidecarRecipeQuickStarts(discoveredQuickStarts, fallbackQuickStarts, input.limit),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setQuickStartsIfChanged(fallbackQuickStarts);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    availableContextKey,
    contextAttachmentsKey,
    availableIntegrationsKey,
    linkedResourcesKey,
    ticketContextKey,
    fallbackQuickStarts,
    input,
    workspaceRoot,
  ]);

  return quickStarts;
}
