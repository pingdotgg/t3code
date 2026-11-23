import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { isWorkspaceCatalogPending, type WorkspaceState } from "../../state/workspaceModel";

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly showsAddEnvironment: boolean;
  readonly showsRetryCatalogLoad: boolean;
}

export function deriveHomeEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  resolve: MessageResolver = m,
): HomeEmptyState {
  if (catalogState.catalogLoadError !== null) {
    return {
      title: resolve(msg("Could not load environments")),
      detail: catalogState.catalogLoadError,
      loading: false,
      showsAddEnvironment: false,
      showsRetryCatalogLoad: true,
    };
  }
  const emptyState = deriveEmptyState(catalogState, projectCount, resolve);
  return {
    ...emptyState,
    showsAddEnvironment: !emptyState.loading && !catalogState.hasReadyEnvironment,
    showsRetryCatalogLoad: false,
  };
}

function deriveEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  resolve: MessageResolver,
): Omit<HomeEmptyState, "showsAddEnvironment" | "showsRetryCatalogLoad"> {
  if (catalogState.isLoadingConnections) {
    return {
      title: resolve(msg("Loading environments")),
      detail: resolve(msg("Checking saved environments on this device.")),
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: resolve(msg("No environments connected")),
      detail: resolve(msg("Add an environment to load projects and start coding sessions.")),
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? resolve(msg("Client not supported"))
          : resolve(msg("Environment unavailable")),
      detail:
        catalogState.connectionError ??
        resolve(
          msg(
            "The saved environment is offline. Check the URL or start the environment, then retry.",
          ),
        ),
      loading: false,
    };
  }

  if (isWorkspaceCatalogPending(catalogState)) {
    return {
      title: catalogState.hasReadyEnvironment
        ? resolve(msg("Loading threads"))
        : resolve(msg("Connecting to environment")),
      detail: resolve(msg("Loading projects and threads from the saved environment.")),
      loading: true,
    };
  }

  if (projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: resolve(msg("No projects found")),
      detail: resolve(msg("The connected environment did not report any projects.")),
      loading: false,
    };
  }

  return {
    title: resolve(msg("No threads yet")),
    detail: resolve(
      msg("Create a task to start a new coding runtime in one of your connected projects."),
    ),
    loading: false,
  };
}
