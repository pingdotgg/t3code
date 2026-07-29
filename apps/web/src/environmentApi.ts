import type { EnvironmentId, EnvironmentApi } from "@t3tools/contracts";

import type { WsRpcClient } from "./rpc/wsRpcClient";
import { readEnvironmentConnection } from "./environments/runtime";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

export function createEnvironmentApi(rpcClient: WsRpcClient): EnvironmentApi {
  return {
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
      readFile: rpcClient.projects.readFile,
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    assets: {
      createUrl: rpcClient.assets.createUrl,
    },
    preview: {
      open: rpcClient.preview.open,
      navigate: rpcClient.preview.navigate,
      reportStatus: rpcClient.preview.reportStatus,
      resize: rpcClient.preview.resize,
      refresh: rpcClient.preview.refresh,
      close: rpcClient.preview.close,
      list: rpcClient.preview.list,
      automation: {
        connect: (input, callback, options) =>
          rpcClient.preview.automation.connect(input, callback, options),
        respond: (response) => rpcClient.preview.automation.respond(response),
        focusHost: (input) => rpcClient.preview.automation.focusHost(input),
      },
      onEvent: (callback) => rpcClient.preview.onEvent(callback),
      subscribePorts: (callback, options) =>
        rpcClient.preview.onDiscoveredLocalServers(callback, options),
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
      listOpenPullRequests: rpcClient.git.listOpenPullRequests,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
      resolveReviewChangesContext: rpcClient.git.resolveReviewChangesContext,
    },
    workflow: {
      run: rpcClient.workflow.run,
    },
    server: {
      listProviderCommands: rpcClient.server.listProviderCommands,
      exportThreadMarkdown: rpcClient.server.exportThreadMarkdown,
    },
    orchestration: {
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getThreadActivities: rpcClient.orchestration.getThreadActivities,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      getTurnDiffState: rpcClient.orchestration.getTurnDiffState,
      getFullThreadDiffState: rpcClient.orchestration.getFullThreadDiffState,
      searchTranscript: rpcClient.orchestration.searchTranscript,
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
    },
  };
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
