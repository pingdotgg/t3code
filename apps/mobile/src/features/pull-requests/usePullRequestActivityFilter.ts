import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { PullRequestActivityVisibility } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { DEFAULT_ACTIVITY_FILTER, type ActivityFilter } from "./pullRequestActivityFilter";

const SHOW_EVERYTHING: PullRequestActivityVisibility = { bots: true, resolved: true };

/**
 * Bot and resolved visibility is a saved preference. A timeline link shows everything for this
 * screen only, until the user picks visibility themselves.
 */
export function usePullRequestActivityFilter(link: string | undefined) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const [view, setView] = useState(() => ({
    kind: link === "commits" ? ("commits" as const) : DEFAULT_ACTIVITY_FILTER.kind,
    newestFirst: DEFAULT_ACTIVITY_FILTER.newestFirst,
    linkVisibility: link === "timeline" ? SHOW_EVERYTHING : null,
  }));
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.pullRequestActivityVisibility
    : undefined;
  const visibility = view.linkVisibility ?? saved ?? DEFAULT_ACTIVITY_FILTER;
  const filter: ActivityFilter = {
    kind: view.kind,
    newestFirst: view.newestFirst,
    bots: visibility.bots,
    resolved: visibility.resolved,
  };
  const visibilityChanged = (next: ActivityFilter) =>
    next.bots !== filter.bots || next.resolved !== filter.resolved;
  return {
    filter,
    setFilter: (next: ActivityFilter) => {
      if (visibilityChanged(next)) {
        void savePreferences({
          pullRequestActivityVisibility: { bots: next.bots, resolved: next.resolved },
        });
      }
      setView((current) => ({
        kind: next.kind,
        newestFirst: next.newestFirst,
        linkVisibility: visibilityChanged(next) ? null : current.linkVisibility,
      }));
    },
    showTimeline: () =>
      setView((current) => ({ ...current, kind: "all", linkVisibility: SHOW_EVERYTHING })),
    showCommits: () => setView((current) => ({ ...current, kind: "commits" })),
  };
}
