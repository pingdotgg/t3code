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
import { FolderBrowser } from "./AddProjectScreenParts4";

export interface EnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platform: string;
  readonly machine: EnvironmentMachineKind;
  readonly baseDirectory: string | null;
  readonly newProjectsRoot: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
}

const environmentOptionOrder = Order.mapInput(
  Order.Struct({
    label: Order.String,
  }),
  (environment: EnvironmentOption) => ({ label: environment.label }),
);

function platformFromOs(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return "";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

export function stringParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function sourceFromParam(value: string | string[] | undefined): AddProjectRemoteSource {
  return parseAddProjectRemoteSource(stringParam(value));
}

export function SectionTitle(props: { readonly children: string }) {
  return (
    <Text
      className={
        Platform.OS === "android"
          ? "px-4 text-sm font-t3-medium text-primary-text"
          : "px-1 text-2xs font-t3-bold tracking-[0.7px] uppercase text-foreground-muted"
      }
    >
      {props.children}
    </Text>
  );
}

export function AddProjectShell(props: { readonly children: ReactNode; readonly title: string }) {
  const insets = useSafeAreaInsets();

  return (
    // A collapsible wrapper lets formSheet resizing mistake the full-height view for a header and collapse the ScrollView.
    <SettingsScreen title={props.title}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: Platform.OS === "android" ? 16 : 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: Platform.OS === "android" ? 16 : 10,
        }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}

export function ListSection(props: { readonly children: ReactNode }) {
  return (
    <View
      className={
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-[24px] bg-grouped-card"
      }
    >
      {props.children}
    </View>
  );
}

export function ListRow(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly isFirst?: boolean;
  readonly right?: ReactNode;
  readonly onPress?: () => void;
}) {
  if (Platform.OS === "android") {
    return (
      <NavigationRow
        className="bg-grouped-card"
        title={props.title}
        subtitle={props.subtitle}
        leading={props.icon}
        trailing={props.right}
        disabled={props.disabled}
        onPress={props.onPress}
        accessibilityRole={props.selected !== undefined ? "radio" : "button"}
        accessibilityState={props.selected !== undefined ? { checked: props.selected } : undefined}
      />
    );
  }
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "bg-grouped-card px-3.5 py-2.5 active:opacity-70",
        !props.isFirst && "border-t border-border-subtle",
        props.disabled && "opacity-[0.45]",
      )}
    >
      <View className="flex-row items-center gap-3">
        <View
          className={
            props.selected
              ? "h-7 w-7 items-center justify-center rounded-full bg-primary"
              : "h-7 w-7 items-center justify-center"
          }
        >
          {props.icon}
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-base leading-snug font-t3-bold">{props.title}</Text>
          {props.subtitle ? (
            <Text className="text-sm leading-snug text-foreground-muted" numberOfLines={2}>
              {props.subtitle}
            </Text>
          ) : null}
        </View>
        {"right" in props ? (
          props.right
        ) : !props.disabled ? (
          <SymbolView
            name="chevron.right"
            size={13}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        ) : null}
      </View>
    </Pressable>
  );
}

export function PrimaryActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress: () => void;
}) {
  return <Button {...props} tone="primary" fullWidth />;
}

export function ProjectPathInput(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <TextInput
      className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
      value={props.value}
      onChangeText={(text) => props.onChangeText(resolvePastedPath(props.value, text))}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder="~/projects/my-app"
      returnKeyType="done"
      onSubmitEditing={props.onSubmit}
    />
  );
}

export function useBrowsePathInput(environment: EnvironmentOption | null, pinnedDirectoryName = "") {
  const environmentId = environment?.environmentId ?? null;
  const environmentBaseDirectory = environment?.baseDirectory ?? null;
  const clonePathCaseSensitive = !isWindowsPlatform(environment?.platform ?? "");
  const seedPath = getCloneDestinationPath(
    getAddProjectInitialQuery(environmentBaseDirectory),
    pinnedDirectoryName,
  );
  // Each host keeps the path last typed or browsed for it, and shows its own default until then,
  // so switching hosts and back loses nothing. With no host selected (one dropping out briefly),
  // the field keeps the last path typed anywhere.
  const [paths, setPaths] = useState<{
    readonly byHost: ReadonlyMap<EnvironmentId, string>;
    readonly last: string;
  }>(() => ({ byHost: new Map(), last: seedPath }));
  const pathInput =
    environmentId === null ? paths.last : (paths.byHost.get(environmentId) ?? seedPath);
  const commitPathInput = (path: string) =>
    setPaths((current) => {
      const byHost = new Map(current.byHost);
      if (environmentId !== null) {
        byHost.set(environmentId, path);
      }
      return { byHost, last: path };
    });
  const environmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const [browseNavigation] = useState(createBrowseNavigationCoordinator);
  const [navigatingEnvironmentId, setNavigatingEnvironmentId] = useState<
    EnvironmentId | null | undefined
  >(undefined);
  const isBrowseNavigating = navigatingEnvironmentId === environmentId;
  const setPathInput = (path: string) => {
    browseNavigation.invalidate();
    setNavigatingEnvironmentId(undefined);
    commitPathInput(path);
  };
  const navigateToBrowsePath = async (input: {
    readonly browseDirectoryPath: string;
    readonly selectedDirectoryName?: string;
  }) => {
    const selectedDirectoryPath = input.selectedDirectoryName
      ? appendBrowsePathSegment(input.browseDirectoryPath, input.selectedDirectoryName)
      : input.browseDirectoryPath;
    const nextPathInput =
      pinnedDirectoryName && input.selectedDirectoryName
        ? getCloneDestinationBrowsePath({
            browseDirectoryPath: input.browseDirectoryPath,
            selectedDirectoryName: input.selectedDirectoryName,
            cloneDirectoryName: pinnedDirectoryName,
            caseSensitive: clonePathCaseSensitive,
          })
        : getCloneDestinationPath(selectedDirectoryPath, pinnedDirectoryName);
    setNavigatingEnvironmentId(environmentId);
    const committed = await browseNavigation.run(
      async () => {
        if (
          environment &&
          readEnvironmentScope(environment.environmentId, AuthFilesystemReadScope) &&
          canPreloadBrowsePath(environmentRuntime?.connectionState)
        ) {
          await loadBrowsePath({
            environmentId: environment.environmentId,
            input: { partialPath: selectedDirectoryPath },
          });
        }
      },
      () => commitPathInput(nextPathInput),
    );
    if (committed) {
      setNavigatingEnvironmentId(undefined);
    }
    return committed;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates the browse navigation coordinator on unmount so in-flight browses do not commit
  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  return { isBrowseNavigating, pathInput, setPathInput, navigateToBrowsePath };
}

export function useEnvironmentOptions(
  selectedEnvironmentId: EnvironmentId | null = null,
): ReadonlyArray<EnvironmentOption> {
  const serverConfigByEnvironmentId = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { connectedEnvironments } = useRemoteConnectionStatus();

  return ((): ReadonlyArray<EnvironmentOption> => {
    const runtimeByEnvironmentId = new Map(
      connectedEnvironments.map((environment) => [environment.environmentId, environment] as const),
    );
    const options = Object.values(savedConnectionsById).map((connection) => {
      const config = serverConfigByEnvironmentId.get(connection.environmentId);
      const runtime = runtimeByEnvironmentId.get(connection.environmentId);
      return {
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        platform: platformFromOs(config?.environment.platform.os ?? null),
        machine: resolveEnvironmentMachineKind(config ?? null),
        baseDirectory: config?.settings.addProjectBaseDirectory ?? null,
        newProjectsRoot: config?.newProjectsRoot ?? null,
        connectionState: runtime?.connectionState ?? "available",
        connectionError: runtime?.connectionError ?? null,
        connectionErrorTraceId: runtime?.connectionErrorTraceId ?? null,
      };
    });
    return Arr.sort(
      options.filter(
        (environment) =>
          canCreateProjectInEnvironment(environment.connectionState) ||
          environment.environmentId === selectedEnvironmentId,
      ),
      environmentOptionOrder,
    );
  })();
}

export function useSelectedEnvironment(requestedEnvironmentId: EnvironmentId | null): {
  readonly environmentOptions: ReadonlyArray<EnvironmentOption>;
  readonly selectedEnvironment: EnvironmentOption | null;
  readonly setSelectedEnvironmentId: (environmentId: EnvironmentId) => void;
} {
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(requestedEnvironmentId);
  const [previousRequest, setPreviousRequest] = useState(requestedEnvironmentId);
  if (previousRequest !== requestedEnvironmentId) {
    setPreviousRequest(requestedEnvironmentId);
    setSelectedEnvironmentId(requestedEnvironmentId);
  }
  const environmentOptions = useEnvironmentOptions(selectedEnvironmentId);
  const selectedEnvironment =
    environmentOptions.find((environment) => environment.environmentId === selectedEnvironmentId) ??
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ??
    null;

  return {
    environmentOptions,
    selectedEnvironment,
    setSelectedEnvironmentId,
  };
}

export function EmptyEnvironmentState() {
  const navigation = useNavigation();

  return (
    <View className="items-center gap-3 rounded-2xl bg-grouped-card px-5 py-8">
      <Text className="text-center text-lg font-t3-bold">Environment unavailable</Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        Start or reconnect an environment before adding a project.
      </Text>
      <View className="mt-1">
        <Button
          label="Add environment"
          tone="primary"
          onPress={() => navigation.dispatch(StackActions.replace("ConnectionsNew"))}
        />
      </View>
    </View>
  );
}

export function SourceControlRow(props: {
  readonly source: AddProjectRemoteSource;
  readonly selectedEnvironmentId: EnvironmentId;
  readonly ready: boolean;
  readonly hint: string;
  readonly isFirst: boolean;
}) {
  const navigation = useNavigation();
  const title =
    props.source === "url" ? "Git URL" : `${addProjectRemoteSourceLabel(props.source)} repository`;
  const subtitle =
    props.source === "url"
      ? "Clone from a remote URL"
      : `Clone ${addProjectRemoteSourceLabel(props.source)} ${props.hint}`;
  const icon =
    props.source === "url" ? (
      <SymbolView
        name="link"
        size={Platform.OS === "android" ? 24 : 17}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    ) : (
      <SourceControlIcon
        icon={sourceControlClients.get(props.source).icon}
        size={Platform.OS === "android" ? 24 : 18}
        colorClassName="accent-icon"
      />
    );

  if (!props.ready) {
    return (
      <ListRow title={title} subtitle={props.hint} icon={icon} disabled isFirst={props.isFirst} />
    );
  }

  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      icon={icon}
      isFirst={props.isFirst}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("AddProjectRepository", {
            environmentId: props.selectedEnvironmentId,
            source: props.source,
          }),
        )
      }
    />
  );
}

export function getActiveRoute(navigation: {
  getState: () => NavigationState<ParamListBase> | undefined;
}) {
  const state = navigation.getState();
  return state?.routes[state.index];
}

export function useOpenNewTaskDraft() {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const selectDetail = useSelectWorkspaceDetail();
  return (
    params: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      title: string;
      cloning?: "1";
      draftId?: string;
    },
    originRoute: NavigationState<ParamListBase>["routes"][number] | undefined,
  ) => {
    const activeRoute = getActiveRoute(navigation);
    // A warm link can change the task without replacing its native route key.
    if (
      !originRoute ||
      activeRoute?.key !== originRoute.key ||
      activeRoute.name !== originRoute.name ||
      activeRoute.params !== originRoute.params
    )
      return;
    selectDetail({ name: "Thread", params: { draft: params } });
  };
}

export async function draftWithPrompt(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  prompt: string,
): Promise<string> {
  await waitForComposerDraftsLoaded();
  const draftId = createNewTaskDraft({ environmentId, projectId });
  setComposerDraftText(draftId, prompt);
  return draftId;
}

function useCreateProject(environment: EnvironmentOption | null) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const navigation = useNavigation();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "project unarchive",
  });
  const projects = useProjects();

  return async (workspaceRoot: string, originRoute = getActiveRoute(navigation)) => {
    if (
      !environment ||
      !canCreateProjectInEnvironment(environment.connectionState) ||
      !readEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope)
    ) {
      Dialog.alert(
        "Project not added",
        `This connection cannot add projects right now. Any existing files remain at ${workspaceRoot}.`,
      );
      return;
    }

    const existing = findExistingAddProject({
      projects,
      environmentId: environment.environmentId,
      path: workspaceRoot,
    });
    if (existing) {
      // Adding an archived project's folder again brings the project back.
      const unarchived =
        existing.archivedAt == null ||
        (
          await updateProject({
            environmentId: existing.environmentId,
            input: { projectId: existing.id, archived: false },
          })
        )._tag === "Success";
      Dialog.alert(
        "Project already exists",
        unarchived ? existing.title : `${existing.title} is still archived. Try again later.`,
      );
      openNewTaskDraft(
        {
          environmentId: existing.environmentId,
          projectId: existing.id,
          title: existing.title,
        },
        originRoute,
      );
      return;
    }

    const projectId = ProjectId.make(uuidv4());
    const command = buildProjectCreateCommand({
      commandId: CommandId.make(uuidv4()),
      projectId,
      workspaceRoot,
    });
    const result = await createProject({
      environmentId: environment.environmentId,
      input: command,
    });
    if (AsyncResult.isFailure(result)) {
      return result;
    }
    // A successful command can precede its project in the client store. The
    // draft treats a missing project as a reason to return to the chooser.
    const project = await waitForProject(
      { environmentId: environment.environmentId, projectId },
      15_000,
    );
    if (project === null) {
      Dialog.alert(
        "Project added",
        "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
      );
      return result;
    }
    openNewTaskDraft(
      {
        environmentId: environment.environmentId,
        projectId,
        title: inferProjectTitleFromPath(workspaceRoot),
      },
      originRoute,
    );
    return result;
  };
}

export function useEnvironmentFromParam(
  environmentIdParam: string | string[] | undefined,
): EnvironmentOption | null {
  const environmentOptions = useEnvironmentOptions();
  const environmentId = stringParam(environmentIdParam) as EnvironmentId | null;
  return resolveAddProjectEnvironment(environmentOptions, environmentId);
}

export function AddProjectLocalFolderScreen(props: { readonly environmentId?: string | string[] }) {
  const environment = useEnvironmentFromParam(props.environmentId);
  const canCreateProject = useEnvironmentScope(
    environment?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const createProject = useCreateProject(environment);
  const { isBrowseNavigating, navigateToBrowsePath, pathInput, setPathInput } =
    useBrowsePathInput(environment);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitPath = async () => {
    if (!environment || isBrowseNavigating || isSubmitting) return;
    setError(null);
    const resolved = resolveAddProjectPath({
      rawPath: pathInput,
      currentProjectCwd: null,
      platform: environment.platform,
    });
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }

    setIsSubmitting(true);
    const result = await createProject(resolved.path);
    if (result && AsyncResult.isFailure(result)) {
      setError(errorMessage(Cause.squash(result.cause)));
    }
    setIsSubmitting(false);
  };

  return (
    <AddProjectShell title="Local folder">
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          {!canCreateProject ? (
            <ErrorBanner message="This connection cannot add projects." />
          ) : null}
          <ProjectPathInput value={pathInput} onChangeText={setPathInput} onSubmit={submitPath} />
          <PrimaryActionButton
            label="Add project"
            disabled={!canCreateProject || isBrowseNavigating || isSubmitting}
            onPress={submitPath}
            loading={isSubmitting}
          />
          <FolderBrowser
            environment={environment}
            navigateToBrowsePath={navigateToBrowsePath}
            pathInput={pathInput}
            setPathInput={setPathInput}
          />
        </>
      ) : (
        <EmptyEnvironmentState />
      )}
    </AddProjectShell>
  );
}
export * from "./AddProjectScreenParts3";
export * from "./AddProjectScreenParts4";
export * from "./AddProjectScreenParts5";
