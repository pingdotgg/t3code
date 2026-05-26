import {
  jsonFile,
  renderAgentsMd,
  renderContextEntrypointPlaceholder,
  renderContextReadme,
  renderRecipeTemplate,
  renderRecipesReadme,
  renderSkillTemplate,
  renderSkillsReadme,
} from "./t3work-projectSetupContent.ts";
import { renderStatusAndContextSkill } from "./t3work-projectSetupStatusSkill.ts";
import {
  DEFAULT_T3WORK_PROJECT_SETUP_PROFILE_ID,
  resolveT3WorkProjectSetupProfileId,
  T3WORK_PROJECT_AGENTS_PATH,
  T3WORK_PROJECT_CONTEXT_ENTRYPOINT_PATH,
  T3WORK_PROJECT_CONTEXT_ROOT,
  T3WORK_PROJECT_PROFILE_MANIFEST_PATH,
  T3WORK_PROJECT_RECIPES_ROOT,
  T3WORK_PROJECT_SETUP_PROFILES,
  T3WORK_PROJECT_SKILLS_ROOT,
  T3WORK_PROJECT_STATUS_SKILL_PATH,
  T3WORK_PROJECT_TEMPLATES_ROOT,
  type T3WorkProjectSetupFile,
  type T3WorkProjectSetupManagedFileHashes,
} from "./t3work-projectSetupShared.ts";
import {
  buildT3WorkProjectAgentsManagedRefresh,
  buildT3WorkProjectSetupProfileManifest,
} from "./t3work-projectSetupManagedRefresh.ts";

export {
  DEFAULT_T3WORK_PROJECT_SETUP_PROFILE_ID,
  resolveT3WorkProjectSetupProfileId,
  T3WORK_PROJECT_AGENTS_PATH,
  T3WORK_PROJECT_CONTEXT_ENTRYPOINT_PATH,
  T3WORK_PROJECT_PROFILE_MANIFEST_PATH,
} from "./t3work-projectSetupShared.ts";

export {
  createT3WorkProjectSetupContentHash,
  readPersistedT3WorkProjectSetupState,
  resolveT3WorkProjectSetupWriteDecision,
} from "./t3work-projectSetupManagedRefresh.ts";

export function renderT3WorkProjectSetupFiles(input?: {
  readonly profileId?: string;
  readonly managedFileHashes?: T3WorkProjectSetupManagedFileHashes;
}): ReadonlyArray<T3WorkProjectSetupFile> {
  const profile =
    T3WORK_PROJECT_SETUP_PROFILES[resolveT3WorkProjectSetupProfileId(input?.profileId)];
  return [
    {
      relativePath: T3WORK_PROJECT_AGENTS_PATH,
      contents: renderAgentsMd(profile),
      writeMode: "if-missing",
      managedRefresh: buildT3WorkProjectAgentsManagedRefresh(profile),
    },
    {
      relativePath: T3WORK_PROJECT_PROFILE_MANIFEST_PATH,
      contents: jsonFile(buildT3WorkProjectSetupProfileManifest(profile, input?.managedFileHashes)),
      writeMode: "overwrite",
    },
    {
      relativePath: `${T3WORK_PROJECT_CONTEXT_ROOT}/README.md`,
      contents: renderContextReadme(),
      writeMode: "if-missing",
    },
    {
      relativePath: T3WORK_PROJECT_CONTEXT_ENTRYPOINT_PATH,
      contents: renderContextEntrypointPlaceholder(),
      writeMode: "if-missing",
    },
    {
      relativePath: `${T3WORK_PROJECT_RECIPES_ROOT}/README.md`,
      contents: renderRecipesReadme(),
      writeMode: "if-missing",
    },
    {
      relativePath: `${T3WORK_PROJECT_SKILLS_ROOT}/README.md`,
      contents: renderSkillsReadme(),
      writeMode: "if-missing",
    },
    {
      relativePath: T3WORK_PROJECT_STATUS_SKILL_PATH,
      contents: renderStatusAndContextSkill(),
      writeMode: "if-missing",
    },
    {
      relativePath: `${T3WORK_PROJECT_TEMPLATES_ROOT}/recipes/repeatable-workflow.md`,
      contents: renderRecipeTemplate(profile),
      writeMode: "if-missing",
    },
    {
      relativePath: `${T3WORK_PROJECT_TEMPLATES_ROOT}/skills/repeatable-workflow/SKILL.md`,
      contents: renderSkillTemplate(profile),
      writeMode: "if-missing",
    },
  ];
}
