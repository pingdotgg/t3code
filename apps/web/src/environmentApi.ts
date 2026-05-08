import type { EnvironmentId, EnvironmentApi } from "@forma/contracts";

import type { WsRpcClient } from "./rpc/wsRpcClient";
import { readEnvironmentConnection } from "./environments/runtime";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();
const environmentApiByRpcClient = new WeakMap<WsRpcClient, EnvironmentApi>();

export function createEnvironmentApi(rpcClient: WsRpcClient): EnvironmentApi {
  const existingApi = environmentApiByRpcClient.get(rpcClient);
  if (existingApi) {
    return existingApi;
  }
  const sourceControl = rpcClient.sourceControl ?? {
    lookupRepository: async () => {
      throw new Error("Source control is unavailable.");
    },
    cloneRepository: async () => {
      throw new Error("Source control is unavailable.");
    },
    publishRepository: async () => {
      throw new Error("Source control is unavailable.");
    },
  };

  const api: EnvironmentApi = {
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      listEntries: rpcClient.projects.listEntries,
      getLocalAgentInventory: rpcClient.projects.getLocalAgentInventory,
      createDirectory: rpcClient.projects.createDirectory,
      renameEntry: rpcClient.projects.renameEntry,
      deleteEntry: rpcClient.projects.deleteEntry,
      readFile: rpcClient.projects.readFile,
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    preview: {
      inspectProject: rpcClient.preview.inspectProject,
      searchComponents: rpcClient.preview.searchComponents,
      resolveTarget: rpcClient.preview.resolveTarget,
      prepareBootstrapThread: rpcClient.preview.prepareBootstrapThread,
      preparePreviewGenerationTurn: rpcClient.preview.preparePreviewGenerationTurn,
      preparePreviewRepairTurn: rpcClient.preview.preparePreviewRepairTurn,
      ensureRuntime: rpcClient.preview.ensureRuntime,
      issueAccessToken: rpcClient.preview.issueAccessToken,
      stopRuntime: rpcClient.preview.stopRuntime,
      subscribeProject: (input, callback, options) =>
        rpcClient.preview.subscribeProject(input, callback, options),
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    sourceControl: {
      lookupRepository: sourceControl.lookupRepository,
      cloneRepository: sourceControl.cloneRepository,
      publishRepository: sourceControl.publishRepository,
    },
    git: {
      pull: rpcClient.git.pull,
      refreshStatus: rpcClient.git.refreshStatus,
      onStatus: (input, callback, options) => rpcClient.git.onStatus(input, callback, options),
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    orchestration: {
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
    },
  };

  environmentApiByRpcClient.set(rpcClient, api);
  return api;
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (!environmentId) {
    return undefined;
  }

  const overriddenApi = environmentApiOverridesForTests.get(environmentId);
  if (overriddenApi) {
    return overriddenApi;
  }

  const connection = readEnvironmentConnection(environmentId);
  return connection ? createEnvironmentApi(connection.client) : undefined;
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(`Environment API not found for environment ${environmentId}`);
  }
  return api;
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
