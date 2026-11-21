import * as Layer from "effect/Layer";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as NativeAppIconResolver from "../../assets/NativeAppIconResolver.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceFolders from "../../workspace/WorkspaceFolders.ts";
import * as TaskFolderStore from "../../workspace/TaskFolderStore.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as ProjectHttp from "../../project/http.ts";

export const layerKnownWorkspaces = KnownWorkspaces.layer.pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provide(GitVcsDriver.layer),
);

const layerWorkspaceEntries = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const layerWorkspaceFileSystem = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(layerWorkspaceEntries),
  Layer.provide(layerKnownWorkspaces),
);

export const layerWorkspace = Layer.mergeAll(
  WorkspacePaths.layer,
  layerWorkspaceEntries,
  layerWorkspaceFileSystem,
  WorkspaceFolders.layer.pipe(
    Layer.provide(Layer.merge(ProjectStore.layer, TaskFolderStore.layer)),
  ),
);

const layerProjectFaviconResolver = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(T3ProjectFileLoader.layer),
);

export const layerProjectEnrichment = ProjectEnrichmentService.layer;

export const layerProjectAssets = Layer.mergeAll(
  NativeAppIconResolver.layer,
  layerProjectFaviconResolver,
);

export const layerProjectHttp = ProjectHttp.layer;
