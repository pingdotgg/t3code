import { EnvironmentId, ProjectId, type PullRequestActor } from "@t3tools/contracts";
import {
  detectPullRequestMention,
  insertPullRequestMention,
  narrowPullRequestMentions,
} from "@t3tools/shared/pullRequestComposerTrigger";
import { useState } from "react";
import type { TextInputSelectionChangeEvent } from "react-native";

import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";

const MENTION_SUGGESTION_LIMIT = 6;

/** Completes `@login` in a pull request text input from the repository's users. */
export function usePullRequestMentions(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly value: string;
  readonly onChangeValue: (value: string) => void;
  /** The pull request's host completes mentions (`capabilities.mentions`), and the field takes them. */
  readonly enabled: boolean;
}) {
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  // Set only right after an insertion, so the native input keeps its own caret otherwise.
  const [placed, setPlaced] = useState<{ start: number; end: number } | null>(null);
  const trigger =
    !input.enabled || selection === null || selection.start !== selection.end
      ? null
      : detectPullRequestMention(input.value, selection.start);
  const typed = trigger?.query ?? "";
  const search = typed === "" ? undefined : typed.slice(0, 100);
  const sent = useDebouncedValue(search, 250);
  const hosted = useEnvironmentQuery(
    trigger === null
      ? null
      : composerPullRequests.filterOptions({
          environmentId: EnvironmentId.make(input.environmentId),
          input: {
            kind: "authors",
            projectId: ProjectId.make(input.projectId),
            ...(sent ? { query: sent } : {}),
          },
        }),
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  const candidates = narrowPullRequestMentions(
    hosted.data?.authors ?? [],
    typed,
    MENTION_SUGGESTION_LIMIT,
  );

  return {
    open: trigger !== null,
    candidates,
    isLoading: hosted.isPending || sent !== search,
    failed: hosted.error !== null,
    selection: placed ?? undefined,
    onSelectionChange: (event: TextInputSelectionChangeEvent) => {
      setSelection(event.nativeEvent.selection);
      setPlaced(null);
    },
    onBlur: () => setSelection(null),
    select: (actor: PullRequestActor) => {
      if (trigger === null) return;
      const next = insertPullRequestMention(input.value, trigger, actor.login);
      input.onChangeValue(next.text);
      setSelection({ start: next.cursor, end: next.cursor });
      setPlaced({ start: next.cursor, end: next.cursor });
    },
  };
}
