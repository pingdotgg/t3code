import type {
  ModelSelection,
  ProjectActionEnvironment,
  ProjectDetails,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadEnvMode,
} from "@t3tools/contracts";

export interface ProjectSettingsDraft {
  readonly projectKey: string;
  readonly title?: string;
  readonly overrideEnabled?: boolean;
  readonly provider?: SourceControlProviderKind;
  readonly remoteName?: string;
  readonly remoteUrl?: string;
  readonly webUrl?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly automaticGitFetchInterval?: number | null;
  readonly actionEnvironment?: ProjectActionEnvironment;
  readonly disabledProviderInstanceIds?: ProviderInstanceId[];
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly newWorktreesStartFromOrigin?: boolean | null;
}

export type ProjectSettingsDraftKey = keyof Omit<ProjectSettingsDraft, "projectKey">;

const valuesEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

const draftKeyMatchesDetails = (
  key: ProjectSettingsDraftKey,
  draft: ProjectSettingsDraft,
  details: ProjectDetails,
) => {
  if (!(key in draft)) return true;

  const override = details.settings.remoteOverride;
  switch (key) {
    case "title":
      return draft.title === details.title;
    case "overrideEnabled":
      return draft.overrideEnabled === Boolean(override);
    case "provider":
      if (draft.overrideEnabled === false && override === null) return true;
      return draft.provider === override?.provider;
    case "remoteName":
      if (draft.overrideEnabled === false && override === null) return true;
      return draft.remoteName === override?.remoteName;
    case "remoteUrl":
      if (draft.overrideEnabled === false && override === null) return true;
      return draft.remoteUrl === override?.remoteUrl;
    case "webUrl":
      if (draft.overrideEnabled === false && override === null) return true;
      return (draft.webUrl || undefined) === override?.webUrl;
    case "defaultModelSelection":
      return valuesEqual(draft.defaultModelSelection, details.defaultModelSelection);
    case "automaticGitFetchInterval":
      return draft.automaticGitFetchInterval === details.settings.automaticGitFetchInterval;
    case "actionEnvironment":
      return valuesEqual(draft.actionEnvironment, details.settings.actionEnvironment);
    case "disabledProviderInstanceIds":
      return valuesEqual(
        draft.disabledProviderInstanceIds,
        details.settings.disabledProviderInstanceIds,
      );
    case "defaultThreadEnvMode":
      return draft.defaultThreadEnvMode === details.settings.defaultThreadEnvMode;
    case "newWorktreesStartFromOrigin":
      return draft.newWorktreesStartFromOrigin === details.settings.newWorktreesStartFromOrigin;
  }
};

export const confirmedProjectSettingsDraftKeys = (
  draft: ProjectSettingsDraft,
  details: ProjectDetails,
  pendingKeys: Iterable<ProjectSettingsDraftKey>,
) => [...pendingKeys].filter((key) => draftKeyMatchesDetails(key, draft, details));

export const commitProviderSettingsThenDefaultModel = async (
  commitProviderSettings: () => Promise<boolean>,
  commitDefaultModel: () => Promise<boolean>,
) => {
  if (!(await commitProviderSettings())) return false;
  return commitDefaultModel();
};
