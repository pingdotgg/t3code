import { pluginActionLabels, pluginActionsAt } from "@t3tools/client-runtime/state/pluginActions";
import type {
  EnvironmentId,
  PluginAction,
  PluginActionTarget,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export interface CommandPaletteItem {
  readonly key: string;
  readonly kind: "action" | "project" | "thread";
  readonly title: string;
  readonly detail?: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly run: () => void;
}

/** `>` narrows to actions, matching the desktop palette. Stable ties retain recent-thread order. */
export function filterCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteItem>,
  query: string,
  matchedThreadKeys: ReadonlySet<string>,
) {
  const actionsOnly = query.startsWith(">");
  const normalized = (actionsOnly ? query.slice(1) : query).trim().toLocaleLowerCase();
  const tokens = normalized.split(/\s+/);
  return items
    .flatMap((item, index) => {
      if (actionsOnly && item.kind !== "action") return [];
      if (!normalized) return item.kind === "project" ? [] : [{ item, rank: 0, index }];
      const title = item.title.toLocaleLowerCase();
      const haystack = [title, ...item.searchTerms].join(" ").toLocaleLowerCase();
      if (
        !tokens.every((token) => haystack.includes(token)) &&
        !(item.kind === "thread" && matchedThreadKeys.has(item.key))
      )
        return [];
      const rank =
        title === normalized
          ? 3
          : title.startsWith(normalized)
            ? 2
            : title.includes(normalized)
              ? 1
              : 0;
      return [{ item, rank, index }];
    })
    .sort((left, right) => right.rank - left.rank || left.index - right.index)
    .map(({ item }) => item);
}

export function nextPaletteIndex(index: number, direction: -1 | 1, count: number) {
  return count === 0 ? 0 : (index + direction + count) % count;
}

/**
 * The palette plugin actions of one environment, for the open thread and its
 * project when there is one. Running one needs `orchestration:operate`, so a
 * connection without it is offered none.
 */
export function buildPluginActionPaletteItems(input: {
  readonly actions: ReadonlyArray<PluginAction>;
  readonly canOperate: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  readonly runAction: (input: {
    readonly environmentId: EnvironmentId;
    readonly action: PluginAction;
    readonly target: PluginActionTarget;
  }) => void;
}): CommandPaletteItem[] {
  if (!input.canOperate) return [];
  const { environmentId } = input;
  const entries = pluginActionsAt(input.actions, "command-palette", {
    threadId: input.threadId,
    projectId: input.projectId,
  });
  const labels = pluginActionLabels(entries.map((entry) => entry.action));
  return entries.map(({ action, target }, index) => ({
    key: `plugin-action:${action.id}`,
    kind: "action",
    title: labels[index] ?? action.title,
    detail: action.description ?? action.pluginName,
    searchTerms: [action.name, action.pluginName, "plugin"],
    run: () => input.runAction({ environmentId, action, target }),
  }));
}
