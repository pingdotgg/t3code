import { T3_PROJECT_FILE_NAME, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode, useContext, useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { droppedSettingKeysAtom, droppedSettingKeysFor } from "./droppedSettingKeys";
import {
  resolveScopedSettingsTargets,
  resolveUnsupportedSettingKeys,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";

function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const files = new Map<string, T3ProjectFile | null>();
          for (const member of members) {
            const result = get(
              getProjectFileQueryAtom(
                member.environmentId,
                member.workspaceRoot,
                T3_PROJECT_FILE_NAME,
              ),
            );
            if (result.waiting) continue;
            const data =
              get(
                optimisticFileAtom(
                  member.environmentId,
                  member.workspaceRoot,
                  T3_PROJECT_FILE_NAME,
                ),
              )?.data ?? Option.getOrNull(AsyncResult.value(result));
            files.set(
              member.physicalProjectKey,
              data === null || data.truncated ? null : parseT3ProjectFile(data.contents),
            );
          }
          return files;
        }),
      [members],
    ),
  );
}

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, singleEnvironment: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const dropped = useAtomValue(droppedSettingKeysAtom);
  const availableEnvironments = useMemo(
    () =>
      environments.map((environment) => {
        const descriptor = environment.serverConfig?.environment;
        const unsupportedSettingKeys = resolveUnsupportedSettingKeys(
          descriptor?.capabilities.settingsKeys,
          droppedSettingKeysFor(dropped, environment.environmentId, descriptor?.serverVersion),
        );
        return unsupportedSettingKeys.size === 0
          ? environment
          : { ...environment, unsupportedSettingKeys };
      }),
    [dropped, environments],
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const search = useMemo(
    () =>
      singleEnvironment
        ? selectSingleEnvironmentScope(
            rawSearch,
            resolveSettingsScope(rawSearch, groups, availableEnvironments),
            availableEnvironments,
            primaryEnvironmentId,
          )
        : rawSearch,
    [availableEnvironments, groups, primaryEnvironmentId, rawSearch, singleEnvironment],
  );
  const scope = useMemo(
    () => resolveSettingsScope(search, groups, availableEnvironments),
    [availableEnvironments, groups, search],
  );
  const projectFiles = useMemberProjectFiles(scope);
  return useMemo(() => {
    const selected = selectScopedSettingsEnvironments(
      scope,
      availableEnvironments,
      primaryEnvironmentId,
    );
    const targets = resolveScopedSettingsTargets(
      scope,
      selected.connectedEnvironments,
      projectFiles,
    );
    const target =
      targets.find(
        (candidate) => candidate.environmentId === selected.environment?.environmentId,
      ) ??
      targets[0] ??
      null;
    return { scope, groups, search, ...selected, targets, target };
  }, [availableEnvironments, groups, primaryEnvironmentId, projectFiles, scope, search]);
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
}: {
  singleEnvironment?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment);
  const value = useMemo(
    () => ({ ...resolved, singleEnvironment, selectScope: onChange }),
    [onChange, resolved, singleEnvironment],
  );
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
