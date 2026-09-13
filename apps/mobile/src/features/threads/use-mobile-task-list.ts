import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useCallback, useRef, useLayoutEffect } from "react";
import { useTasks } from "../../state/tasks";
import { environmentServerConfigsAtom } from "../../state/server";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useMobileTaskList() {
  const tasks = useTasks();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const value = AsyncResult.isSuccess(preferences) ? preferences.value : {};
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  }, [value]);
  const toggle = useCallback(
    (key: string, shelf = false) => {
      if (!AsyncResult.isSuccess(preferences)) return;
      const field = shelf ? "expandedTaskShelfKeys" : "collapsedTaskKeys";
      const keys = new Set(latest.current[field] ?? []);
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      const patch = { [field]: [...keys] };
      latest.current = { ...latest.current, ...patch };
      update(patch);
    },
    [preferences, update],
  );
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
