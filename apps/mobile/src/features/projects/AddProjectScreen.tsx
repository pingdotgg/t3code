import {
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  buildAddProjectRemoteSourceReadiness,
  buildProjectCreateCommand,
  findExistingAddProject,
  getAddProjectInitialQuery,
  resolveAddProjectPath,
  sortAddProjectProviderSources,
  type AddProjectRemoteSource,
} from "@t3tools/client-runtime/operations/projects";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  ensureBrowseDirectoryPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isFilesystemBrowseQuery,
} from "@t3tools/client-runtime/state/projects";
import { CommandId, type EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Order from "effect/Order";
import { AsyncResult } from "effect/unstable/reactivity";

import { useProjects, useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SourceControlIcon } from "../../components/SourceControlIcon";
import { useThemeColor } from "../../lib/useThemeColor";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";

interface EnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platform: string;
  readonly baseDirectory: string | null;
}

const environmentOptionOrder = Order.mapInput(
  Order.Struct({
    label: Order.String,
  }),
  (environment: EnvironmentOption) => ({ label: environment.label }),
);

const browseEntryOrder = Order.mapInput(
  Order.String,
  (entry: { readonly name: string }) => entry.name,
);

function platformFromOs(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

function stringParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function sourceFromParam(value: string | string[] | undefined): AddProjectRemoteSource {
  const source = stringParam(value);
  if (
    source === "url" ||
    source === "github" ||
    source === "gitlab" ||
    source === "bitbucket" ||
    source === "azure-devops"
  ) {
    return source;
  }
  return "url";
}

function SectionTitle(props: { readonly children: string }) {
  return (
    <Text
      className="px-1 text-[11px] font-t3-bold uppercase text-foreground-muted"
      style={{ letterSpacing: 0.7 }}
    >
      {props.children}
    </Text>
  );
}

function AddProjectShell(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: 10,
        }}
      >
        {props.children}
      </ScrollView>
    </View>
  );
}

function ListSection(props: { readonly children: ReactNode }) {
  return <View className="overflow-hidden rounded-[24px] bg-card">{props.children}</View>;
}

function ListRow(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly isFirst?: boolean;
  readonly right?: ReactNode;
  readonly onPress?: () => void;
}) {
  const borderColor = useThemeColor("--color-border-subtle");
  const chevronColor = useThemeColor("--color-chevron");

  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      className="bg-card px-3.5 py-2.5 active:opacity-70"
      style={{
        opacity: props.disabled ? 0.45 : 1,
        borderTopWidth: props.isFirst ? 0 : 1,
        borderTopColor: borderColor,
      }}
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
          <Text className="text-[16px] leading-[21px] font-t3-bold">{props.title}</Text>
          {props.subtitle ? (
            <Text className="text-[13px] leading-[17px] text-foreground-muted" numberOfLines={2}>
              {props.subtitle}
            </Text>
          ) : null}
        </View>
        {"right" in props ? (
          props.right
        ) : !props.disabled ? (
          <SymbolView name="chevron.right" size={13} tintColor={chevronColor} type="monochrome" />
        ) : null}
      </View>
    </Pressable>
  );
}

function PrimaryActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress: () => void;
}) {
  const primaryForeground = useThemeColor("--color-primary-foreground");

  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-12 items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-45"
    >
      {props.loading ? (
        <ActivityIndicator color={String(primaryForeground)} />
      ) : (
        <Text className="text-[14px] font-t3-bold text-primary-foreground">{props.label}</Text>
      )}
    </Pressable>
  );
}

function ProjectPathInput(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <TextInput
      className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-[15px] leading-[20px]"
      value={props.value}
      onChangeText={props.onChangeText}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder="~/projects/my-app"
      returnKeyType="done"
      onSubmitEditing={props.onSubmit}
    />
  );
}

function useEnvironmentOptions(): ReadonlyArray<EnvironmentOption> {
  const serverConfigByEnvironmentId = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();

  return useMemo<ReadonlyArray<EnvironmentOption>>(() => {
    const options = Object.values(savedConnectionsById).map((connection) => {
      const config = serverConfigByEnvironmentId.get(connection.environmentId);
      return {
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        platform: platformFromOs(config?.environment.platform.os ?? null),
        baseDirectory: config?.settings.addProjectBaseDirectory ?? null,
      };
    });
    return Arr.sort(options, environmentOptionOrder);
  }, [savedConnectionsById, serverConfigByEnvironmentId]);
}

function useSelectedEnvironment(): {
  readonly environmentOptions: ReadonlyArray<EnvironmentOption>;
  readonly selectedEnvironment: EnvironmentOption | null;
  readonly setSelectedEnvironmentId: (environmentId: EnvironmentId) => void;
} {
  const router = useRouter();
  const params = useLocalSearchParams<{ environmentId?: string }>();
  const environmentOptions = useEnvironmentOptions();
  const requestedEnvironmentId = stringParam(params.environmentId) as EnvironmentId | null;
  const selectedEnvironment =
    environmentOptions.find(
      (environment) => environment.environmentId === requestedEnvironmentId,
    ) ??
    environmentOptions[0] ??
    null;

  return {
    environmentOptions,
    selectedEnvironment,
    setSelectedEnvironmentId: (environmentId) => router.setParams({ environmentId }),
  };
}

function EmptyEnvironmentState() {
  const router = useRouter();

  return (
    <View className="items-center gap-3 rounded-2xl bg-card px-5 py-8">
      <Text className="text-center text-[17px] font-t3-bold">No environments connected</Text>
      <Text className="text-center text-[14px] leading-[20px] text-foreground-muted">
        Add an environment before adding a project.
      </Text>
      <Pressable
        onPress={() => router.replace("/connections/new")}
        className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
      >
        <Text className="text-[13px] font-t3-bold text-primary-foreground">Add environment</Text>
      </Pressable>
    </View>
  );
}

function SourceControlRow(props: {
  readonly source: AddProjectRemoteSource;
  readonly selectedEnvironmentId: EnvironmentId;
  readonly ready: boolean;
  readonly hint: string;
  readonly isFirst: boolean;
}) {
  const router = useRouter();
  const iconColor = useThemeColor("--color-icon");
  const title =
    props.source === "url" ? "Git URL" : `${addProjectRemoteSourceLabel(props.source)} repository`;
  const subtitle =
    props.source === "url"
      ? "Clone from a remote URL"
      : `Clone ${addProjectRemoteSourceLabel(props.source)} ${props.hint}`;
  const icon =
    props.source === "url" ? (
      <SymbolView name="link" size={17} tintColor={iconColor} type="monochrome" />
    ) : (
      <SourceControlIcon kind={props.source} size={18} color={String(iconColor)} />
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
        router.push({
          pathname: "/new/add-project/repository",
          params: {
            environmentId: props.selectedEnvironmentId,
            source: props.source,
          },
        })
      }
    />
  );
}

export function AddProjectSourceScreen() {
  const router = useRouter();
  const accentColor = useThemeColor("--color-icon-muted");
  const iconColor = useThemeColor("--color-icon");
  const { environmentOptions, selectedEnvironment, setSelectedEnvironmentId } =
    useSelectedEnvironment();
  const discoveryState = useEnvironmentQuery(
    selectedEnvironment === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: selectedEnvironment.environmentId,
          input: {},
        }),
  );
  const readiness = useMemo(
    () => buildAddProjectRemoteSourceReadiness(discoveryState.data),
    [discoveryState.data],
  );

  return (
    <AddProjectShell>
      {environmentOptions.length === 0 ? <EmptyEnvironmentState /> : null}

      {environmentOptions.length > 1 ? (
        <>
          <SectionTitle>Connected environments</SectionTitle>
          <ListSection>
            {environmentOptions.map((environment, index) => (
              <ListRow
                key={environment.environmentId}
                title={environment.label}
                subtitle={environment.environmentId}
                icon={
                  <SymbolView
                    name="server.rack"
                    size={17}
                    tintColor={iconColor}
                    type="monochrome"
                  />
                }
                selected={environment.environmentId === selectedEnvironment?.environmentId}
                isFirst={index === 0}
                right={
                  environment.environmentId === selectedEnvironment?.environmentId ? (
                    <SymbolView
                      name="checkmark"
                      size={14}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                  ) : null
                }
                onPress={() => setSelectedEnvironmentId(environment.environmentId)}
              />
            ))}
          </ListSection>
        </>
      ) : null}

      {selectedEnvironment ? (
        <>
          <ListSection>
            <ListRow
              title="Local folder"
              subtitle="Browse a folder on disk"
              icon={
                <SymbolView
                  name="folder.badge.plus"
                  size={17}
                  tintColor={iconColor}
                  type="monochrome"
                />
              }
              isFirst
              onPress={() =>
                router.push({
                  pathname: "/new/add-project/local",
                  params: { environmentId: selectedEnvironment.environmentId },
                })
              }
            />
            {(["url", ...sortAddProjectProviderSources(readiness)] as AddProjectRemoteSource[]).map(
              (candidate) => (
                <SourceControlRow
                  key={candidate}
                  source={candidate}
                  selectedEnvironmentId={selectedEnvironment.environmentId}
                  ready={readiness[candidate].ready}
                  hint={
                    readiness[candidate].ready
                      ? addProjectRemoteSourcePathHint(candidate)
                      : (readiness[candidate].hint ?? "")
                  }
                  isFirst={false}
                />
              ),
            )}
          </ListSection>
          {discoveryState.isPending ? <ActivityIndicator color={accentColor} /> : null}
        </>
      ) : null}
    </AddProjectShell>
  );
}

function useCreateProject(environment: EnvironmentOption | null) {
  const router = useRouter();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const projects = useProjects();

  return useCallback(
    async (workspaceRoot: string) => {
      if (!environment) return;

      const existing = findExistingAddProject({
        projects,
        environmentId: environment.environmentId,
        path: workspaceRoot,
      });
      if (existing) {
        Alert.alert("Project already exists", existing.title);
        router.replace({
          pathname: "/new/draft",
          params: {
            environmentId: existing.environmentId,
            projectId: existing.id,
            title: existing.title,
          },
        });
        return;
      }

      const projectId = ProjectId.make(uuidv4());
      const command = buildProjectCreateCommand({
        commandId: CommandId.make(uuidv4()),
        projectId,
        workspaceRoot,
        createdAt: new Date().toISOString(),
      });
      const result = await createProject({
        environmentId: environment.environmentId,
        input: command,
      });
      if (AsyncResult.isFailure(result)) {
        return result;
      }
      router.replace({
        pathname: "/new/draft",
        params: {
          environmentId: environment.environmentId,
          projectId,
          title: inferProjectTitleFromPath(workspaceRoot),
        },
      });
      return result;
    },
    [createProject, environment, projects, router],
  );
}

function useEnvironmentFromParam(): EnvironmentOption | null {
  const params = useLocalSearchParams<{ environmentId?: string }>();
  const environmentOptions = useEnvironmentOptions();
  const environmentId = stringParam(params.environmentId) as EnvironmentId | null;
  return (
    environmentOptions.find((environment) => environment.environmentId === environmentId) ??
    environmentOptions[0] ??
    null
  );
}

export function AddProjectRepositoryScreen() {
  const lookupRepositoryQuery = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const router = useRouter();
  const params = useLocalSearchParams<{ environmentId?: string; source?: string }>();
  const environment = useEnvironmentFromParam();
  const source = sourceFromParam(params.source);
  const [repositoryInput, setRepositoryInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookupRepository = useCallback(async () => {
    if (!environment || repositoryInput.trim().length === 0 || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    const provider = addProjectRemoteSourceProvider(source);
    if (!provider) {
      const remoteUrl = repositoryInput.trim();
      router.push({
        pathname: "/new/add-project/destination",
        params: {
          environmentId: environment.environmentId,
          source,
          remoteUrl,
          repositoryTitle: remoteUrl,
        },
      });
      setIsSubmitting(false);
      return;
    }

    const result = await lookupRepositoryQuery({
      environmentId: environment.environmentId,
      input: {
        provider,
        repository: repositoryInput.trim(),
      },
    });
    if (AsyncResult.isFailure(result)) {
      setError(errorMessage(Cause.squash(result.cause)));
    } else {
      const repository = result.value;
      router.push({
        pathname: "/new/add-project/destination",
        params: {
          environmentId: environment.environmentId,
          source,
          remoteUrl: repository.sshUrl,
          repositoryTitle: repository.nameWithOwner,
        },
      });
    }
    setIsSubmitting(false);
  }, [environment, isSubmitting, lookupRepositoryQuery, repositoryInput, router, source]);

  return (
    <AddProjectShell>
      {error ? <ErrorBanner message={error} /> : null}
      <TextInput
        className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-[15px] leading-[20px]"
        value={repositoryInput}
        onChangeText={setRepositoryInput}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={
          source === "url"
            ? "https://github.com/org/repo.git"
            : addProjectRemoteSourcePathHint(source)
        }
        returnKeyType="next"
        onSubmitEditing={() => void lookupRepository()}
      />
      <PrimaryActionButton
        label={source === "url" ? "Continue" : "Lookup repository"}
        disabled={isSubmitting || repositoryInput.trim().length === 0}
        onPress={() => void lookupRepository()}
        loading={isSubmitting}
      />
    </AddProjectShell>
  );
}

function FolderBrowser(props: {
  readonly environment: EnvironmentOption;
  readonly pathInput: string;
  readonly setPathInput: (path: string) => void;
}) {
  const accentColor = useThemeColor("--color-icon-muted");
  const browseDirectoryPath = useMemo(
    () =>
      isFilesystemBrowseQuery(props.pathInput, props.environment.platform)
        ? getBrowseDirectoryPath(props.pathInput)
        : "",
    [props.environment.platform, props.pathInput],
  );
  const browseFilterQuery =
    browseDirectoryPath.length > 0 && !hasTrailingPathSeparator(props.pathInput)
      ? getBrowseLeafPathSegment(props.pathInput).toLowerCase()
      : "";
  const browseInput = useMemo(
    () => (browseDirectoryPath.length > 0 ? { partialPath: browseDirectoryPath } : null),
    [browseDirectoryPath],
  );
  const browseState = useEnvironmentQuery(
    browseInput === null
      ? null
      : filesystemEnvironment.browse({
          environmentId: props.environment.environmentId,
          input: browseInput,
        }),
  );
  const visibleBrowseEntries = useMemo(
    () =>
      Arr.sort(
        Arr.filter(
          browseState.data?.entries ?? [],
          (entry) =>
            !entry.name.startsWith(".") && entry.name.toLowerCase().startsWith(browseFilterQuery),
        ),
        browseEntryOrder,
      ),
    [browseFilterQuery, browseState.data?.entries],
  );
  const parentBrowsePath = getBrowseParentPath(browseDirectoryPath);
  const canBrowseUpPath = canNavigateUp(browseDirectoryPath);

  return (
    <>
      <SectionTitle>Browse folders</SectionTitle>
      {browseState.error ? <ErrorBanner message={browseState.error} /> : null}
      <ListSection>
        {browseState.isPending && browseState.data === null ? (
          <View className="items-center py-5">
            <ActivityIndicator color={accentColor} />
          </View>
        ) : null}
        {canBrowseUpPath ? (
          <ListRow
            title=".."
            icon={
              <SymbolView
                name="arrow.turn.left.up"
                size={17}
                tintColor={accentColor}
                type="monochrome"
              />
            }
            isFirst
            right={null}
            onPress={() => {
              if (parentBrowsePath) props.setPathInput(parentBrowsePath);
            }}
          />
        ) : null}
        {visibleBrowseEntries.map((entry, index) => (
          <ListRow
            key={entry.fullPath}
            title={entry.name}
            icon={<SymbolView name="folder" size={17} tintColor={accentColor} type="monochrome" />}
            isFirst={index === 0 && !canBrowseUpPath}
            right={null}
            onPress={() =>
              props.setPathInput(
                browseDirectoryPath.length > 0
                  ? appendBrowsePathSegment(browseDirectoryPath, entry.name)
                  : ensureBrowseDirectoryPath(entry.fullPath),
              )
            }
          />
        ))}
      </ListSection>
    </>
  );
}

export function AddProjectLocalFolderScreen() {
  const environment = useEnvironmentFromParam();
  const createProject = useCreateProject(environment);
  const [pathInput, setPathInput] = useState(() =>
    getAddProjectInitialQuery(environment?.baseDirectory),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!environment) return;
    setPathInput(getAddProjectInitialQuery(environment.baseDirectory));
  }, [environment]);

  const submitPath = useCallback(async () => {
    if (!environment || isSubmitting) return;
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
  }, [createProject, environment, isSubmitting, pathInput]);

  return (
    <AddProjectShell>
      {error ? <ErrorBanner message={error} /> : null}
      {environment ? (
        <>
          <ProjectPathInput
            value={pathInput}
            onChangeText={setPathInput}
            onSubmit={() => void submitPath()}
          />
          <PrimaryActionButton
            label="Add project"
            disabled={isSubmitting}
            onPress={() => void submitPath()}
            loading={isSubmitting}
          />
          <FolderBrowser
            environment={environment}
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

export function AddProjectDestinationScreen() {
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const params = useLocalSearchParams<{
    environmentId?: string;
    remoteUrl?: string;
    repositoryTitle?: string;
  }>();
  const environment = useEnvironmentFromParam();
  const createProject = useCreateProject(environment);
  const remoteUrl = stringParam(params.remoteUrl);
  const repositoryTitle = stringParam(params.repositoryTitle);
  const [pathInput, setPathInput] = useState(() =>
    getAddProjectInitialQuery(environment?.baseDirectory),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!environment) return;
    setPathInput(getAddProjectInitialQuery(environment.baseDirectory));
  }, [environment]);

  const submitPath = useCallback(async () => {
    if (!environment || !remoteUrl || isSubmitting) return;
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
    const cloneResult = await cloneRepository({
      environmentId: environment.environmentId,
      input: {
        remoteUrl,
        destinationPath: resolved.path,
      },
    });
    if (AsyncResult.isFailure(cloneResult)) {
      setError(errorMessage(Cause.squash(cloneResult.cause)));
    } else {
      const createResult = await createProject(cloneResult.value.cwd);
      if (createResult && AsyncResult.isFailure(createResult)) {
        setError(errorMessage(Cause.squash(createResult.cause)));
      }
    }
    setIsSubmitting(false);
  }, [cloneRepository, createProject, environment, isSubmitting, pathInput, remoteUrl]);

  return (
    <AddProjectShell>
      {error ? <ErrorBanner message={error} /> : null}
      {repositoryTitle ? (
        <View className="rounded-[24px] bg-card px-4 py-3">
          <Text className="text-[14px] font-t3-bold">{repositoryTitle}</Text>
          <Text className="mt-0.5 text-[12px] text-foreground-muted" numberOfLines={2}>
            {remoteUrl}
          </Text>
        </View>
      ) : null}
      {environment ? (
        <>
          <ProjectPathInput
            value={pathInput}
            onChangeText={setPathInput}
            onSubmit={() => void submitPath()}
          />
          <PrimaryActionButton
            label="Clone project"
            disabled={isSubmitting || !remoteUrl}
            onPress={() => void submitPath()}
            loading={isSubmitting}
          />
          <FolderBrowser
            environment={environment}
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
