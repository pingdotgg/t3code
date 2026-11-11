import { threadShortcutHref, threadShortcutLabel } from "../features/shortcuts/appShortcuts";
import type { RecentThreadShortcut } from "../persistence/imperative";

// Widget props are stored in UserDefaults, which rejects null: absent values are absent keys.
export interface QuickActionsProps {
  newThreadUrl: string;
  lastThread?: { title: string; url: string };
}

/** `origin` is the app's link prefix, such as `t3code://`. */
export function quickActionsProps(
  origin: string,
  recents: ReadonlyArray<RecentThreadShortcut>,
): QuickActionsProps {
  const last = recents[0];
  return {
    newThreadUrl: `${origin}new`,
    ...(last
      ? {
          lastThread: {
            title: threadShortcutLabel(last),
            // The href's ids are already encoded; a URL builder would encode them again.
            url: `${origin}${threadShortcutHref(last).slice(1)}`,
          },
        }
      : {}),
  };
}
