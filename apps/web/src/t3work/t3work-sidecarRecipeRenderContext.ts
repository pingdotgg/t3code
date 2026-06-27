import {
  type DiscoverProjectRecipesRequest,
  type ProjectRecipeRenderContext,
  type RecipeSurface,
} from "@t3tools/project-recipes";
import { createQueryable } from "@t3tools/project-context";
import {
  getT3WorkProfile,
  resolveEnabledSkillPackIds,
  toRecipeProfileContext,
} from "@t3tools/t3work-skill-packs";

import type { T3WorkContextAttachment } from "~/t3work/t3work-contextAttachment";
import { buildAvailableContextKeys } from "~/t3work/t3work-sidecarRecipeContextKeys";
import type { T3workSidecarRecipeInput } from "~/t3work/t3work-sidecarRecipeTypes";

function resolveRecipeSurface(
  input: Pick<T3workSidecarRecipeInput, "surface" | "dashboardMode">,
): RecipeSurface {
  if (input.surface === "project.dashboard") {
    return input.dashboardMode === "my-work"
      ? "project.dashboard.myWork"
      : "project.dashboard.backlog";
  }
  return input.surface;
}

function hasAttachedWorkitem(
  attachments: ReadonlyArray<T3WorkContextAttachment> | undefined,
): boolean {
  return (attachments ?? []).some((attachment) => attachment.kind === "jira-work-item");
}

function buildRenderContextAttachments(
  attachments: ReadonlyArray<T3WorkContextAttachment> | undefined,
) {
  return (attachments ?? []).map((attachment) => {
    const renderAttachment = {
      kind: attachment.kind,
      label: attachment.label,
    } as {
      kind: string;
      label: string;
      description?: string;
      jiraIssueType?: string;
      summaryItems?: typeof attachment.summaryItems;
    };

    if (attachment.description) {
      renderAttachment.description = attachment.description;
    }
    if (attachment.jiraIssueType) {
      renderAttachment.jiraIssueType = attachment.jiraIssueType;
    }
    if (attachment.summaryItems) {
      renderAttachment.summaryItems = attachment.summaryItems;
    }

    return renderAttachment;
  });
}

function hasExplicitWorkitemContext(input: T3workSidecarRecipeInput): boolean {
  return Boolean(
    input.resourceKind || input.selectedWorkTitle || input.jiraIssueType || input.workitemPriority,
  );
}

export function buildRecipeRenderContext(
  input: T3workSidecarRecipeInput,
  profile: ReturnType<typeof getT3WorkProfile>,
  workspaceRoot?: string,
): ProjectRecipeRenderContext {
  const surface = resolveRecipeSurface(input);
  const explicitWorkitemContext = hasExplicitWorkitemContext(input);
  const attachedWorkitem = hasAttachedWorkitem(input.contextAttachments);
  const availableContextKeys = buildAvailableContextKeys(input);
  const integrationLinkedResources = [...new Set(input.availableIntegrations ?? [])]
    .filter((provider) => provider !== input.project.source.provider)
    .map((provider, index) => ({
      id: `${provider}-${index}`,
      kind: `integration.${provider}`,
      provider,
      label: provider,
    }));
  const linkedResources = [...integrationLinkedResources, ...(input.linkedResources ?? [])];
  const workitem = explicitWorkitemContext
    ? {
        ...(input.resourceKind ? { kind: input.resourceKind } : {}),
        displayId: input.selectedWorkLabel,
        ...(input.selectedWorkTitle ? { title: input.selectedWorkTitle } : {}),
        ...(input.jiraIssueType ? { type: input.jiraIssueType } : {}),
        ...(input.workitemPriority ? { priority: input.workitemPriority } : {}),
        ...(input.ticketContext?.status ? { status: input.ticketContext.status } : {}),
        ...(input.ticketContext?.assignee ? { assignee: input.ticketContext.assignee } : {}),
        ...(input.ticketContext?.assigneeRelation
          ? { assigneeRelation: input.ticketContext.assigneeRelation }
          : {}),
        ...(typeof input.ticketContext?.estimateValue === "number"
          ? { estimateValue: input.ticketContext.estimateValue }
          : {}),
        ...(typeof input.ticketContext?.originalEstimateHours === "number"
          ? { originalEstimateHours: input.ticketContext.originalEstimateHours }
          : {}),
        ...(typeof input.ticketContext?.remainingEstimateHours === "number"
          ? { remainingEstimateHours: input.ticketContext.remainingEstimateHours }
          : {}),
        ...(input.ticketContext?.relationships
          ? { relationships: input.ticketContext.relationships }
          : {}),
        ...(input.ticketContext?.github ? { github: input.ticketContext.github } : {}),
        ...(input.project.source.provider === "atlassian" && input.resourceKind === "ticket"
          ? { provider: "jira" }
          : { provider: input.project.source.provider }),
      }
    : undefined;
  const contextAttachments =
    input.contextAttachments && input.contextAttachments.length > 0
      ? createQueryable(buildRenderContextAttachments(input.contextAttachments))
      : undefined;
  const surfaceState = {
    hasContextAttachments: (input.contextAttachments?.length ?? 0) > 0,
    hasSelectedWork: explicitWorkitemContext || attachedWorkitem,
    ...(input.currentViewSummary ? { currentView: input.currentViewSummary } : {}),
  };
  const baseContext = {
    project: {
      id: input.project.id,
      title: input.project.title,
      provider: input.project.source.provider,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    },
    linkedResources: createQueryable(linkedResources),
    artifacts: createQueryable([]),
    profile: {
      id: profile.id,
      title: profile.title,
      ...toRecipeProfileContext(profile),
    },
    enabledSkillPacks: resolveEnabledSkillPackIds({ profile }),
    schema: {},
    availableContextKeys: createQueryable(availableContextKeys),
  };

  if (surface === "project.dashboard.backlog") {
    return {
      surface,
      ...baseContext,
      ...(workitem ? { workitem } : {}),
      ...(contextAttachments ? { contextAttachments } : {}),
      surfaceState: {
        dashboardMode: "backlog",
        ...surfaceState,
      },
    };
  }

  if (surface === "project.dashboard.myWork") {
    return {
      surface,
      ...baseContext,
      ...(workitem ? { workitem } : {}),
      ...(contextAttachments ? { contextAttachments } : {}),
      surfaceState: {
        dashboardMode: "my-work",
        ...surfaceState,
      },
    };
  }

  return {
    surface,
    ...baseContext,
    ...(workitem ? { workitem } : {}),
    ...(contextAttachments ? { contextAttachments } : {}),
    ...(explicitWorkitemContext ||
    attachedWorkitem ||
    input.contextAttachments?.length ||
    input.currentViewSummary
      ? { surfaceState }
      : {}),
  };
}

export function buildProjectRecipeDiscoveryRequest(
  input: T3workSidecarRecipeInput & { readonly workspaceRoot: string },
): DiscoverProjectRecipesRequest {
  const profile = getT3WorkProfile(input.profileId);
  return {
    workspaceRoot: input.workspaceRoot,
    context: buildRecipeRenderContext(input, profile, input.workspaceRoot),
  };
}
