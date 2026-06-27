import { matchRecipes } from "@t3tools/project-recipes";
import {
  getT3WorkProfile,
  getT3WorkSkillPack,
  listBundledT3WorkRecipes,
  resolveEnabledSkillPackIds,
  toRecipeProfileContext,
  type T3WorkProfile,
  type T3WorkSkillPack,
} from "@t3tools/t3work-skill-packs";

export type T3workProjectSetupConfirmPreview = {
  readonly profile: T3WorkProfile;
  readonly enabledSkillPackIds: ReadonlyArray<string>;
  readonly skillPacks: ReadonlyArray<T3WorkSkillPack>;
  readonly topRecipes: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly reason: string;
  }>;
};

export function buildT3workProjectSetupConfirmPreview(input: {
  readonly profileId: string;
  readonly customProfile?: T3WorkProfile | undefined;
}): T3workProjectSetupConfirmPreview {
  const profile = input.customProfile ?? getT3WorkProfile(input.profileId);
  const enabledSkillPackIds = resolveEnabledSkillPackIds({ profile });
  const skillPacks = enabledSkillPackIds.flatMap((packId) => {
    const pack = getT3WorkSkillPack(packId);
    return pack ? [pack] : [];
  });

  const topRecipes = matchRecipes(listBundledT3WorkRecipes(), {
    activeProject: { source: { provider: "atlassian" } },
    selectedResource: null,
    resourceKind: "ticket",
    availableIntegrations: ["atlassian"],
    surface: "workitem.detail.sidepanel",
    enabledSkillPacks: enabledSkillPackIds,
    profile: toRecipeProfileContext(profile),
    availableContextKeys: [
      "ticket.summary",
      "project.summary",
      "ticket.context.pre-implementation",
    ],
  })
    .filter((result) => result.missingContext.length === 0)
    .slice(0, 5)
    .map((result) => ({
      id: result.recipe.id,
      title: result.recipe.title,
      reason: result.reason,
    }));

  return { profile, enabledSkillPackIds, skillPacks, topRecipes };
}
