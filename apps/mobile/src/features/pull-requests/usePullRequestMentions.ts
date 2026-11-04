import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestActor,
  type PullRequestFilterOptionsInput,
} from "@t3tools/contracts";
import {
  detectPullRequestMention,
  insertPullRequestMention,
  narrowPullRequestMentions,
  pullRequestMentionSearch,
} from "@t3tools/shared/pullRequestComposerTrigger";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import type { TextInputSelectionChangeEvent } from "react-native";

import { composerPullRequests } from "../../state/pull-requests";
import { useDebouncedValue } from "../../state/queries";

const MENTION_SUGGESTION_LIMIT = 6;

const mentionOptionsFamily = Atom.family((key: string) => {
  const target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestFilterOptionsInput;
  } | null = JSON.parse(key);
  return Atom.make((get) => {
    if (target === null) return { authors: [], waiting: false, failed: false };
    const result = get(composerPullRequests.filterOptions(target));
    return {
      authors: Option.match(AsyncResult.value(result), {
        onNone: () => [] as ReadonlyArray<PullRequestActor>,
        onSome: (options) => options.authors,
      }),
      waiting: result.waiting,
      failed: AsyncResult.isFailure(result),
    };
  });
});

/** Completes `@login` in a pull request text input from the repository's users. */
export function usePullRequestMentions(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly value: string;
  readonly onChangeValue: (value: string) => void;
  readonly enabled?: boolean;
}) {
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  // Set only right after an insertion, so the native input keeps its own caret otherwise.
  const [placed, setPlaced] = useState<{ start: number; end: number } | null>(null);
  const trigger =
    input.enabled === false || selection === null || selection.start !== selection.end
      ? null
      : detectPullRequestMention(input.value, selection.start);
  const typed = trigger?.query ?? "";
  const search = pullRequestMentionSearch(typed);
  const sent = useDebouncedValue(search, 250);
  const hosted = useAtomValue(
    mentionOptionsFamily(
      JSON.stringify(
        trigger === null
          ? null
          : {
              environmentId: EnvironmentId.make(input.environmentId),
              input: {
                kind: "authors",
                projectId: ProjectId.make(input.projectId),
                ...(sent ? { query: sent } : {}),
              },
            },
      ),
    ),
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  const candidates = narrowPullRequestMentions(hosted.authors, typed, MENTION_SUGGESTION_LIMIT);

  return {
    open: trigger !== null,
    candidates,
    isLoading: hosted.waiting || sent !== search,
    failed: hosted.failed,
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
