import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  getProjectOrderKey,
  moveProjectOrderKeys,
  orderProjectsByProjectOrder,
  pendingProjectOrder,
  readSharedProjectOrder,
  visibleProjectOrder,
  type PendingProjectOrder,
} from "@t3tools/client-runtime/state/project-grouping";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

/** Folders are on when any connected environment's server settings turn them on. */
export function useProjectFoldersEnabled(): boolean {
  const { environments } = useEnvironments();
  return environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.settings.sidebarProjectFoldersEnabled === true,
  );
}

function toggled(keys: readonly string[], key: string): readonly string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

/** Collapsed folders, saved on this device in the existing collapsedProjectGroups preference. */
export function useProjectFolderCollapse(): {
  readonly loaded: boolean;
  readonly collapsedKeys: ReadonlySet<string>;
  readonly toggleFolder: (folderKey: string) => void;
} {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const signature = loaded
    ? [...(preferencesResult.value.collapsedProjectGroups ?? [])].sort().join("\n")
    : "";
  // Stable identity while contents are unchanged: list items compare by content.
  const collapsedKeys = useMemo<ReadonlySet<string>>(
    () => new Set(signature === "" ? [] : signature.split("\n")),
    [signature],
  );

  const toggleFolder = (folderKey: string) => {
    if (!loaded) return;
    // Transforms read optimistic state so same-frame presses toggle twice.
    savePreferences({
      transform: (current) => ({
        collapsedProjectGroups: toggled(current.collapsedProjectGroups ?? [], folderKey),
      }),
    });
  };

  return { loaded, collapsedKeys, toggleFolder };
}

const pendingProjectOrderAtom = Atom.make<PendingProjectOrder | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pending-project-order"),
);

function useSharedProjectOrder(): ReadonlyArray<string> {
  const { environments } = useEnvironments();
  return readSharedProjectOrder(
    environments.map((environment) =>
      environment.connection.phase === "connected" ? environment.serverConfig?.settings : null,
    ),
  );
}

/** Projects in the manual order the clients share through the servers, which folders follow. */
export function useProjectsInFolderOrder(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<EnvironmentProject> {
  const shared = useSharedProjectOrder();
  const pending = useAtomValue(pendingProjectOrderAtom);
  const order = visibleProjectOrder(shared, pending);
  // Stable while the order's contents are unchanged: list items compare by content.
  const signature = order.join("\n");
  return useMemo(
    () => orderProjectsByProjectOrder(projects, signature === "" ? [] : signature.split("\n")),
    [projects, signature],
  );
}

/**
 * Moves a folder to another folder's place and writes the new project order to every server
 * that shares settings, so desktop and the other devices follow. Null when no server takes it.
 */
export function useProjectFolderMove(
  scopes: ReadonlyArray<{
    readonly key: string;
    readonly projects: ReadonlyArray<EnvironmentProject>;
  }>,
  projects: ReadonlyArray<EnvironmentProject>,
): ((folderKey: string, targetKey: string) => void) | null {
  const { environments } = useEnvironments();
  const targets = environments.filter(supportsSharedSettingsSync);
  const writable = useEnvironmentsWithScope(targets, AuthSettingsWriteScope);
  const shared = useSharedProjectOrder();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "project order update",
    reportFailure: true,
  });
  if (writable.size === 0) return null;
  const orderKeysOf = (folderKey: string) =>
    scopes.find((scope) => scope.key === folderKey)?.projects.map(getProjectOrderKey) ?? [];
  return (folderKey, targetKey) => {
    const visible = visibleProjectOrder(shared, appAtomRegistry.get(pendingProjectOrderAtom));
    const order = orderProjectsByProjectOrder(projects, visible).map(getProjectOrderKey);
    const next = moveProjectOrderKeys(order, orderKeysOf(folderKey), orderKeysOf(targetKey));
    if (next === null) return;
    const pending = pendingProjectOrder(shared, next);
    appAtomRegistry.set(pendingProjectOrderAtom, pending);
    const writes = targets
      .filter((environment) => writable.has(environment.environmentId))
      .map((environment) =>
        updateSettings({
          environmentId: environment.environmentId,
          input: { patch: { sidebarProjectOrder: next } },
        }),
      );
    void Promise.all(writes).then((results) => {
      if (
        results.every((result) => result._tag === "Failure") &&
        appAtomRegistry.get(pendingProjectOrderAtom) === pending
      ) {
        appAtomRegistry.set(pendingProjectOrderAtom, null);
      }
    });
  };
}
