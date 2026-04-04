import { type ContextMenuItem, type NativeApi } from "@t3tools/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { resetServerStateForTests } from "./rpc/serverState";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";

let instance: { api: NativeApi } | null = null;

export function __resetWsNativeApiForTests() {
  instance = null;
  __resetWsRpcClientForTests();
  resetServerStateForTests();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const getRpcClient = () => getWsRpcClient();

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => getRpcClient().terminal.open(input as never),
      write: (input) => getRpcClient().terminal.write(input as never),
      resize: (input) => getRpcClient().terminal.resize(input as never),
      clear: (input) => getRpcClient().terminal.clear(input as never),
      restart: (input) => getRpcClient().terminal.restart(input as never),
      close: (input) => getRpcClient().terminal.close(input as never),
      onEvent: (callback) => getRpcClient().terminal.onEvent(callback),
    },
    projects: {
      searchEntries: (input) => getRpcClient().projects.searchEntries(input),
      writeFile: (input) => getRpcClient().projects.writeFile(input),
    },
    shell: {
      openInEditor: (cwd, editor) => getRpcClient().shell.openInEditor({ cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: (input) => getRpcClient().git.pull(input),
      status: (input) => getRpcClient().git.status(input),
      listBranches: (input) => getRpcClient().git.listBranches(input),
      createWorktree: (input) => getRpcClient().git.createWorktree(input),
      removeWorktree: (input) => getRpcClient().git.removeWorktree(input),
      createBranch: (input) => getRpcClient().git.createBranch(input),
      checkout: (input) => getRpcClient().git.checkout(input),
      init: (input) => getRpcClient().git.init(input),
      resolvePullRequest: (input) => getRpcClient().git.resolvePullRequest(input),
      preparePullRequestThread: (input) => getRpcClient().git.preparePullRequestThread(input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => getRpcClient().server.getConfig(),
      refreshProviders: () => getRpcClient().server.refreshProviders(),
      upsertKeybinding: (input) => getRpcClient().server.upsertKeybinding(input),
      getSettings: () => getRpcClient().server.getSettings(),
      updateSettings: (patch) => getRpcClient().server.updateSettings(patch),
    },
    vault: {
      listSecrets: async () => {
        if (!window.desktopBridge) {
          throw new Error("Vault secrets are only available in the desktop app.");
        }
        return window.desktopBridge.listVaultSecrets();
      },
      saveSecret: async (input) => {
        if (!window.desktopBridge) {
          throw new Error("Vault secrets are only available in the desktop app.");
        }
        return window.desktopBridge.saveVaultSecret(input);
      },
      deleteSecret: async (input) => {
        if (!window.desktopBridge) {
          throw new Error("Vault secrets are only available in the desktop app.");
        }
        return window.desktopBridge.deleteVaultSecret(input);
      },
      subscribeSecrets: (callback) => {
        if (!window.desktopBridge) {
          return () => undefined;
        }
        return window.desktopBridge.subscribeVaultSecrets(callback);
      },
    },
    orchestration: {
      getSnapshot: () => getRpcClient().orchestration.getSnapshot(),
      dispatchCommand: (command) => getRpcClient().orchestration.dispatchCommand(command),
      getTurnDiff: (input) => getRpcClient().orchestration.getTurnDiff(input),
      getFullThreadDiff: (input) => getRpcClient().orchestration.getFullThreadDiff(input),
      replayEvents: (fromSequenceExclusive) =>
        getRpcClient()
          .orchestration.replayEvents({ fromSequenceExclusive })
          .then((events) => [...events]),
      onDomainEvent: (callback) => getRpcClient().orchestration.onDomainEvent(callback),
    },
  };

  instance = { api };
  return api;
}
