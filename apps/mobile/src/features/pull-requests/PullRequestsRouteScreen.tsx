import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListState,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";
import { useHomeListOptions } from "../home/home-list-options";
import { PullRequestsScreen, type PullRequestListEnvironment } from "./PullRequestsScreen";
import { usePullRequestList } from "./usePullRequestList";

export function PullRequestsRouteScreen() {
  const navigation = useNavigation();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { environments: workspaceEnvironments } = useWorkspaceState();
  const [searchQuery, setSearchQuery] = useState("");
  const [involvement, setInvolvement] = useState<PullRequestInvolvement>("all");
  const [state, setState] = useState<PullRequestListState>("open");
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | undefined>(undefined);
  const [selectedHost, setSelectedHost] = useState<string | undefined>(undefined);

  const environments = useMemo<ReadonlyArray<PullRequestListEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
          supported:
            serverConfigs.get(connection.environmentId)?.environment.capabilities.pullRequests ===
            true,
        })),
        Order.mapInput(Order.String, (environment: PullRequestListEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [savedConnectionsById, serverConfigs],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options } = useHomeListOptions(availableEnvironmentIds);
  const capable = useMemo(
    () => environments.filter((environment) => environment.supported),
    [environments],
  );
  const connectedCapable = useMemo(() => {
    const connected = new Set(
      workspaceEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    );
    return capable.filter((environment) => connected.has(environment.environmentId));
  }, [capable, workspaceEnvironments]);
  const preferredEnvironmentId =
    options.selectedEnvironmentId !== null &&
    capable.some((environment) => environment.environmentId === options.selectedEnvironmentId)
      ? options.selectedEnvironmentId
      : (connectedCapable[0]?.environmentId ?? capable[0]?.environmentId ?? null);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    preferredEnvironmentId,
  );
  useEffect(() => {
    if (
      selectedEnvironmentId === null ||
      !environments.some((environment) => environment.environmentId === selectedEnvironmentId)
    ) {
      setSelectedEnvironmentId(preferredEnvironmentId);
    }
  }, [environments, preferredEnvironmentId, selectedEnvironmentId]);

  const selected = environments.find(
    (environment) => environment.environmentId === selectedEnvironmentId,
  );
  const capabilityKnown =
    selectedEnvironmentId !== null && serverConfigs.has(selectedEnvironmentId);
  const supported = selected?.supported === true;
  const scopedProjects = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === selectedEnvironmentId)
        .map((project) => ({ id: project.id, title: project.title }))
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [projects, selectedEnvironmentId],
  );
  const list = usePullRequestList({
    environmentId: selectedEnvironmentId,
    supported,
    involvement,
    state,
    projectId: selectedProjectId,
    host: selectedHost,
    query: searchQuery,
    projects: scopedProjects,
    projectsKnown: selectedEnvironmentId !== null,
  });

  return (
    <PullRequestsScreen
      canLoadMore={list.canLoadMore}
      capabilityKnown={capabilityKnown}
      environments={environments}
      error={list.error}
      firstLoad={list.firstLoad}
      groups={list.groups}
      hasProjects={scopedProjects.length > 0}
      hosts={list.providers}
      involvement={involvement}
      loadingMore={list.loadingMore}
      onAddProject={() =>
        navigation.navigate("NewTaskSheet", {
          screen: "AddProject",
        })
      }
      onEnvironmentChange={setSelectedEnvironmentId}
      onHostChange={setSelectedHost}
      onInvolvementChange={setInvolvement}
      onLoadMore={list.loadMore}
      onProjectChange={setSelectedProjectId}
      onRefresh={() => void list.refreshFromHost()}
      onSearchQueryChange={setSearchQuery}
      onSelect={(entry) => {
        if (selectedEnvironmentId === null) return;
        navigation.navigate("PullRequestDetail", {
          environmentId: String(selectedEnvironmentId),
          projectId: String(entry.projectId),
          repository: entry.repository,
          number: String(entry.number),
        });
      }}
      onStateChange={setState}
      projects={scopedProjects}
      querySettled={list.querySettled}
      refreshing={list.refreshing}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      selectedHost={selectedHost}
      selectedProjectId={selectedProjectId}
      state={state}
      supported={supported}
    />
  );
}
