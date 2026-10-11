import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isCloudEnvironmentConfig,
  preferredCloudEnvironment,
  selectedCloudEnvironment,
  selectsCloudEnvironmentSetup,
  selectsCloudRun,
  withCloudRunOptions,
  type EnvironmentId,
  type ProjectId,
  type ProviderCloudConfiguration,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type RepositoryIdentity,
  type ServerProvider,
} from "@t3tools/contracts";

import { cloudEnvironments, useCloudRunPreferences } from "../../cloudRunStore";
import { useEnvironmentQuery } from "../../state/query";
import type { CloudRunOption } from "../BranchToolbar.logic";
import { CloudEnvironmentDialog } from "./CloudEnvironmentDialog";
import { useCloudEnvironmentSetupBannerItem } from "./CloudEnvironmentSetupBanner";

/**
 * The composer's Cloud location under Run on: whether it is offered and
 * chosen, the Codex Cloud environment it runs in, and the dialog that picks,
 * creates, and publishes environments. Like a machine, the choice is made
 * before the thread starts, then fixed.
 */
export function useComposerCloudRun(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId | undefined;
  repositoryIdentity: RepositoryIdentity | null | undefined;
  provider: ServerProvider | null;
  instanceId: ProviderInstanceId | null | undefined;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  envLocked: boolean;
  /** Keys the dialog so it resets per thread. */
  threadKey: string;
  setModelOptions: (options: ReadonlyArray<ProviderOptionSelection>) => void;
  /** Opens a new draft that sets up `config` in a setup conversation. */
  openSetupDraft: (config: ProviderCloudConfiguration) => void;
}) {
  const { environmentId, instanceId, modelOptions, envLocked, setModelOptions } = input;
  const [dialogPage, setDialogPage] = useState<"choose" | "review" | null>(null);
  const label = input.provider?.cloudRun?.label;
  const selected = selectsCloudRun(modelOptions);
  const requiresEnvironment = input.provider?.cloudRun?.requiresEnvironment === true;
  const environment = selectedCloudEnvironment(modelOptions);
  const identity = input.repositoryIdentity;
  const repository =
    identity?.provider === "github" && identity.owner && identity.name
      ? `${identity.owner}/${identity.name}`
      : undefined;

  const environmentsQuery = useEnvironmentQuery(
    selected && requiresEnvironment && instanceId
      ? cloudEnvironments.list({
          environmentId,
          input: { instanceId, ...(repository ? { repository } : {}) },
        })
      : null,
  );
  const environments = useMemo(
    () => (environmentsQuery.error ? [] : (environmentsQuery.data ?? [])),
    [environmentsQuery.data, environmentsQuery.error],
  );
  const chosen = environments.find((entry) => entry.id === environment);
  const preferenceKey = JSON.stringify([environmentId, input.projectId, instanceId]);
  const remembered = useCloudRunPreferences((state) => state.byProject[preferenceKey]);
  const remember = useCloudRunPreferences((state) => state.remember);

  // A new cloud draft starts in the project's remembered or suggested environment.
  const preferred = preferredCloudEnvironment(environments, remembered);
  useEffect(() => {
    if (!selected || !requiresEnvironment || envLocked || environment || !preferred) return;
    setModelOptions(withCloudRunOptions(modelOptions, { environment: preferred }));
  }, [
    selected,
    requiresEnvironment,
    envLocked,
    environment,
    preferred,
    modelOptions,
    setModelOptions,
  ]);

  const openReview = useCallback(() => setDialogPage("review"), []);
  const bannerItem = useCloudEnvironmentSetupBannerItem(
    selectsCloudEnvironmentSetup(modelOptions) &&
      instanceId &&
      isCloudEnvironmentConfig(environment)
      ? { environmentId, instanceId, configId: environment }
      : null,
    openReview,
  );

  const onChange = useCallback(
    (cloud: boolean) => {
      if (cloud && requiresEnvironment) setDialogPage("choose");
      setModelOptions(withCloudRunOptions(modelOptions, cloud ? { environment } : null));
    },
    [environment, modelOptions, requiresEnvironment, setModelOptions],
  );
  const cloudRun = useMemo<CloudRunOption | undefined>(
    () =>
      label
        ? {
            label: chosen ? `${label} · ${chosen.label}` : label,
            selected,
            ...(envLocked ? {} : { onChange }),
          }
        : undefined,
    [label, chosen, selected, envLocked, onChange],
  );
  const openEnvironmentPicker = useCallback(() => setDialogPage("choose"), []);
  const needsEnvironment = selected && requiresEnvironment && !envLocked && !chosen;

  const dialog =
    dialogPage && selected && requiresEnvironment && instanceId ? (
      <CloudEnvironmentDialog
        key={`${input.threadKey}:${instanceId}`}
        environmentId={environmentId}
        instanceId={instanceId}
        repository={repository}
        readOnly={envLocked}
        initialPage={dialogPage}
        inSetupConversation={selectsCloudEnvironmentSetup(modelOptions)}
        onSetup={(config) => {
          setDialogPage(null);
          input.openSetupDraft(config);
        }}
        environments={environments}
        preferredId={environment ?? preferred}
        loading={environmentsQuery.isPending}
        error={environmentsQuery.error}
        onRefresh={environmentsQuery.refresh}
        onClose={() => setDialogPage(null)}
        onSelect={(id) => {
          setModelOptions(withCloudRunOptions(modelOptions, { environment: id }));
          remember(preferenceKey, id);
          setDialogPage(null);
        }}
      />
    ) : null;

  return {
    cloudRun,
    bannerItem,
    dialog,
    /** Why sending is blocked, if it is: the draft still needs an environment. */
    sendBlockReason: needsEnvironment ? "Choose a Codex Cloud environment in Run on" : null,
    openEnvironmentPicker,
  };
}
