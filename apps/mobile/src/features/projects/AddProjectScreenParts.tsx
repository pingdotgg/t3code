import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Button } from "../../components/ui/Button";
import {
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  buildAddProjectRemoteSourceReadiness,
  buildProjectCreateCommand,
  canCreateProjectInEnvironment,
  findExistingAddProject,
  getAddProjectInitialQuery,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  getNewProjectPathPreview,
  getNewProjectPublishTarget,
  getNewProjectPublishTargets,
  getNewProjectRepository,
  githubIncompleteOwnerRepositoryMessage,
  defaultHostCloneUrl,
  normalizePastedCloneUrl,
  parseAddProjectRemoteSource,
  resolveAddProjectPath,
  sortAddProjectProviderSources,
  type AddProjectRemoteSource,
} from "@t3tools/client-runtime/operations/projects";
import {
  connectionStatusText,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  resolveFilesystemReadAccess,
} from "@t3tools/client-runtime/state/filesystem";
import {
  appendBrowsePathSegment,
  inferProjectTitleFromPath,
  isWindowsPlatform,
} from "@t3tools/client-runtime/state/projects";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  CommandId,
  type EnvironmentId,
  type EnvironmentMachineKind,
  ProjectId,
  resolveEnvironmentMachineKind,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  StackActions,
  useNavigation,
  type NavigationState,
  type ParamListBase,
} from "@react-navigation/native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Order from "effect/Order";
import { AsyncResult } from "effect/reactivity";
import { cn } from "../../lib/cn";
import { useProjects, useServerConfigs, waitForProject } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession, useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useEnvironmentPresentation } from "../../state/presentation";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { SourceControlIcon } from "./SourceControlIcon";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { suggestAppAccessForRemote } from "./suggestAppAccess";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { resolveAddProjectEnvironment } from "./AddProjectScreen.logic";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { AddProjectShell, EmptyEnvironmentState, ListRow, ListSection, PrimaryActionButton, errorMessage, getActiveRoute, stringParam, useEnvironmentOptions, useOpenNewTaskDraft } from "./AddProjectScreen";

export function AddProjectNewScreen(props: { readonly environmentId?: string | string[] }) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const navigation = useNavigation();
  const environmentOptions = useEnvironmentOptions().filter(
    (option) => option.newProjectsRoot !== null,
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    () => stringParam(props.environmentId) as EnvironmentId | null,
  );
  const environment = resolveAddProjectEnvironment(environmentOptions, selectedEnvironmentId);
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const checkPublishedAppAccess = useAtomCommand(sourceControlEnvironment.checkAppAccess, {
    reportFailure: false,
    reportDefect: false,
  });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const discoveryState = useEnvironmentQuery(
    environment === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: environment.environmentId,
          input: {},
        }),
  );
  const publishTargets = getNewProjectPublishTargets(discoveryState.data);
  const [name, setName] = useState("");
  const [publishes, setPublishes] = useState(false);
  const [publishKind, setPublishKind] = useState<SourceControlProviderKind | null>(null);
  const publishTarget = getNewProjectPublishTarget(publishTargets, publishKind);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const pathPreview =
    environment?.newProjectsRoot != null
      ? getNewProjectPathPreview(environment.newProjectsRoot, trimmedName)
      : null;

  const showMachines =
    environmentOptions.length > 1 || (environment === null && environmentOptions.length > 0);
  const machineRows = showMachines ? (
    <ListSection>
      {environmentOptions.map((option, index) => {
        const selected = option.environmentId === environment?.environmentId;
        return (
          <ListRow
            key={option.environmentId}
            title={option.label}
            icon={
              <EnvironmentMachineSymbol
                kind={option.machine}
                size={Platform.OS === "android" ? 24 : 17}
                tintColorClassName="accent-icon"
              />
            }
            selected={selected}
            disabled={isSubmitting}
            isFirst={index === 0}
            right={
              selected ? (
                <SymbolView
                  name="checkmark"
                  size={Platform.OS === "android" ? 20 : 14}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              ) : null
            }
            onPress={() => setSelectedEnvironmentId(option.environmentId)}
          />
        );
      })}
    </ListSection>
  ) : null;

  // State lags a render behind, so a double tap could start a second create.
  const submittingRef = useRef(false);
  const submit = async () => {
    if (!environment || trimmedName.length === 0 || submittingRef.current) return;
    const originRoute = getActiveRoute(navigation);
    submittingRef.current = true;
    setError(null);
    setIsSubmitting(true);
    const result = await createNew({
      environmentId: environment.environmentId,
      input: { name: trimmedName },
    });
    if (AsyncResult.isFailure(result)) {
      submittingRef.current = false;
      setIsSubmitting(false);
      setError(errorMessage(Cause.squash(result.cause)));
      return;
    }
    const { projectId, workspaceRoot, commitError } = result.value;
    if (commitError !== undefined) {
      Dialog.alert("Created without a first commit", commitError);
    }
    if (publishes && publishTarget !== null) {
      void publishRepository({
        environmentId: environment.environmentId,
        input: {
          cwd: workspaceRoot,
          provider: publishTarget.definition.kind,
          repository: getNewProjectRepository(publishTarget, workspaceRoot),
          visibility: "private",
        },
      }).then((publishResult) => {
        if (AsyncResult.isFailure(publishResult)) {
          Dialog.alert(
            `Could not create the ${publishTarget.definition.label} repository`,
            errorMessage(Cause.squash(publishResult.cause)),
          );
        } else {
          void suggestAppAccessForRemote(
            checkPublishedAppAccess,
            environment.environmentId,
            publishResult.value.remoteUrl,
          );
        }
      });
    }
    // The draft screen resolves its project from the client store, so it
    // must not open before the create event has arrived.
    const project = await waitForProject(
      { environmentId: environment.environmentId, projectId },
      15_000,
    );
    submittingRef.current = false;
    setIsSubmitting(false);
    if (project === null) {
      setName("");
      setError(
        "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
      );
      return;
    }
    openNewTaskDraft(
      {
        environmentId: environment.environmentId,
        projectId,
        title: trimmedName,
      },
      originRoute,
    );
  };

  return (
    <AddProjectShell title="New project">
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          <TextInput
            className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
            value={name}
            onChangeText={setName}
            autoCorrect={false}
            autoFocus
            placeholder="Project name"
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
          {pathPreview !== null ? (
            <Text className="px-1 text-sm leading-snug text-foreground-muted" numberOfLines={2}>
              {trimmedName.length > 0
                ? `Creates ${pathPreview}`
                : `Goes in ${environment.newProjectsRoot}`}
              {showMachines ? ` on ${environment.label}` : null}
            </Text>
          ) : null}
          {machineRows}
          {publishTarget !== null ? (
            <ListSection>
              <ListRow
                title={`Create private repository on ${publishTarget.definition.label}`}
                subtitle={
                  trimmedName.length > 0 && pathPreview !== null
                    ? getNewProjectRepository(publishTarget, pathPreview)
                    : publishTarget.owner
                }
                icon={
                  <SourceControlIcon
                    icon={publishTarget.definition.icon}
                    size={Platform.OS === "android" ? 24 : 18}
                    colorClassName="accent-icon"
                  />
                }
                isFirst
                right={
                  <ThemedSwitch
                    accessibilityLabel={`Create private repository on ${publishTarget.definition.label}`}
                    value={publishes}
                    onValueChange={setPublishes}
                  />
                }
                onPress={() => setPublishes((current) => !current)}
              />
              {publishes && publishTargets.length > 1
                ? publishTargets.map((target) => {
                    const selected = target.definition.kind === publishTarget.definition.kind;
                    return (
                      <ListRow
                        key={target.definition.kind}
                        title={target.definition.label}
                        icon={
                          <SourceControlIcon
                            icon={target.definition.icon}
                            size={Platform.OS === "android" ? 24 : 17}
                            colorClassName="accent-icon"
                          />
                        }
                        selected={selected}
                        disabled={isSubmitting}
                        right={
                          selected ? (
                            <SymbolView
                              name="checkmark"
                              size={Platform.OS === "android" ? 20 : 14}
                              tintColorClassName="accent-icon"
                              type="monochrome"
                            />
                          ) : null
                        }
                        onPress={() => setPublishKind(target.definition.kind)}
                      />
                    );
                  })
                : null}
            </ListSection>
          ) : null}
          <PrimaryActionButton
            label="Create project"
            disabled={isSubmitting || trimmedName.length === 0}
            onPress={() => void submit()}
            loading={isSubmitting}
          />
          <ListSection>
            <ListRow
              title="Add existing project"
              subtitle="Open a folder or clone a repository"
              icon={
                <SymbolView
                  name="folder.badge.plus"
                  size={Platform.OS === "android" ? 24 : 17}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              }
              isFirst
              onPress={() =>
                navigation.canGoBack()
                  ? navigation.goBack()
                  : navigation.dispatch(StackActions.replace("AddProject"))
              }
            />
          </ListSection>
        </>
      ) : environmentOptions.length > 0 ? (
        machineRows
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}

