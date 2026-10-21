import type { Action } from "expo-quick-actions";
import type { NavigationState } from "@react-navigation/native";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import type { RecentThreadShortcut } from "../../persistence/imperative";

export const MAX_RECENT_THREAD_SHORTCUTS = 3;

export const NEW_TASK_SHORTCUT_ID = "new-task";
const NEW_TASK_SHORTCUT_HREF = "/new";

const SHORTCUT_ICON = "shortcut_icon";

const THREAD_SHORTCUT_HREF_PATTERN = /^\/threads\/[^/?#]+\/[^/?#]+$/;

function threadShortcutHref(thread: RecentThreadShortcut): string {
  return `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`;
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

/** Never throw: malformed deep-link or restored ids can fail schema constructors during root-stack render. */
export function activeThreadRef(state: NavigationState): ScopedThreadRef | null {
  const route = state.routes[state.index];
  if (route?.name !== "Thread") {
    return null;
  }

  try {
    const params = route.params as
      | {
          readonly environmentId?: string | string[];
          readonly threadId?: string | string[];
        }
      | undefined;
    const environmentId = firstRouteParam(params?.environmentId)?.trim();
    const threadId = firstRouteParam(params?.threadId)?.trim();
    if (!environmentId || !threadId) {
      return null;
    }

    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  } catch {
    return null;
  }
}

function threadShortcutLabel(thread: RecentThreadShortcut): string {
  const title = thread.title.trim();
  return title.length > 0 ? title : "Thread";
}

/** Launcher shortcuts survive updates; allowlist destinations so malformed or stale paths cannot navigate. */
export function shortcutHref(action: Action): string | null {
  const href = action.params?.href;
  if (typeof href !== "string") {
    return null;
  }

  return href === NEW_TASK_SHORTCUT_HREF || THREAD_SHORTCUT_HREF_PATTERN.test(href) ? href : null;
}

export function withRecentThreadShortcut(
  current: ReadonlyArray<RecentThreadShortcut>,
  opened: RecentThreadShortcut,
): ReadonlyArray<RecentThreadShortcut> {
  const existing = current.find(
    (thread) =>
      thread.environmentId === opened.environmentId && thread.threadId === opened.threadId,
  );
  const title = opened.title.trim().length > 0 ? opened.title : (existing?.title ?? opened.title);
  if (current[0] === existing && existing !== undefined && existing.title === title) {
    return current;
  }

  return [
    { environmentId: opened.environmentId, threadId: opened.threadId, title },
    ...current.filter((thread) => thread !== existing),
  ].slice(0, MAX_RECENT_THREAD_SHORTCUTS);
}

export function buildShortcutActions(recents: ReadonlyArray<RecentThreadShortcut>): Action[] {
  return [
    {
      id: NEW_TASK_SHORTCUT_ID,
      title: "New task",
      icon: SHORTCUT_ICON,
      params: { href: NEW_TASK_SHORTCUT_HREF },
    },
    ...recents.slice(0, MAX_RECENT_THREAD_SHORTCUTS).map((thread): Action => ({
      // URI-encoded hrefs avoid env/thread id collisions that plain hyphen joins allow.
      id: `thread:${threadShortcutHref(thread)}`,
      title: threadShortcutLabel(thread),
      icon: SHORTCUT_ICON,
      params: { href: threadShortcutHref(thread) },
    })),
  ];
}
