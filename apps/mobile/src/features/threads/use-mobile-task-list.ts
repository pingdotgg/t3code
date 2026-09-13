import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useCallback, useRef } from "react";
import { useTasks } from "../../state/tasks";
import { environmentServerConfigsAtom } from "../../state/server";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Expansion commands read preferences on invocation; rows need no inventory subscription. */
export function useMobileTaskListActions() {
  const update = useAtomSet(updateMobilePreferencesAtom);
  const latest = useRef<{
    source: unknown;
    value: { collapsedTaskKeys?: readonly string[]; expandedTaskShelfKeys?: readonly string[] };
  }>({ source: null, value: {} });
  return useCallback(
    (key: string, shelf = false, present?: boolean) => {
      const preferences = appAtomRegistry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return;
      if (latest.current.source !== preferences) {
        latest.current = { source: preferences, value: preferences.value };
      }
      const field = shelf ? "expandedTaskShelfKeys" : "collapsedTaskKeys";
      const keys = new Set(latest.current.value[field] ?? preferences.value[field] ?? []);
      if (present ?? !keys.has(key)) keys.add(key);
      else keys.delete(key);
      const patch = { [field]: [...keys] };
      latest.current.value = { ...latest.current.value, ...patch };
      update(patch);
    },
    [update],
  );
}

export function useMobileTaskList() {
  const tasks = useTasks();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const value = AsyncResult.isSuccess(preferences) ? preferences.value : {};
  const toggle = useMobileTaskListActions();
  return useMemo(
    () => ({
      tasks,
      capableIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.tasks === true ? [id] : [],
        ),
      ),
      collapsedTaskKeys: new Set(value.collapsedTaskKeys ?? []),
      expandedTaskShelfKeys: new Set(value.expandedTaskShelfKeys ?? []),
      toggle,
    }),
    [tasks, configs, value.collapsedTaskKeys, value.expandedTaskShelfKeys, toggle],
  );
}
