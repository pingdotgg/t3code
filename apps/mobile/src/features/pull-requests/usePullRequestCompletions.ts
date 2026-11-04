import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestActor,
  type PullRequestFilterOptionsInput,
  type PullRequestReferenceCandidate,
} from "@t3tools/contracts";
import {
  detectPullRequestComposerTrigger,
  insertPullRequestCompletion,
  narrowPullRequestMentions,
  narrowPullRequestReferences,
  pullRequestCompletionSearch,
} from "@t3tools/shared/pullRequestComposerTrigger";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import type { TextInputSelectionChangeEvent } from "react-native";

import { composerPullRequests } from "../../state/pull-requests";
import { useDebouncedValue } from "../../state/queries";

const COMPLETION_SUGGESTION_LIMIT = 6;

export type PullRequestCompletion =
  | { readonly kind: "mention"; readonly token: string; readonly actor: PullRequestActor }
  | {
      readonly kind: "reference";
      readonly token: string;
      readonly candidate: PullRequestReferenceCandidate;
    };

const completionOptionsFamily = Atom.family((key: string) => {
  const target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestFilterOptionsInput;
  } | null = JSON.parse(key);
  return Atom.make((get) => {
    if (target === null) return { authors: [], references: [], waiting: false, failed: false };
    const result = get(composerPullRequests.filterOptions(target));
    const options = Option.getOrNull(AsyncResult.value(result));
    return {
      authors: options?.authors ?? ([] as ReadonlyArray<PullRequestActor>),
      references: options?.references ?? ([] as ReadonlyArray<PullRequestReferenceCandidate>),
      waiting: result.waiting,
      failed: AsyncResult.isFailure(result),
    };
  });
});

/** Completes `@login`, `#123` and GitLab `!123` in a pull request text input. */
export function usePullRequestCompletions(input: {
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
      : detectPullRequestComposerTrigger(input.value, selection.start);
  const search = trigger === null ? undefined : pullRequestCompletionSearch(trigger);
  const wanted = trigger === null ? null : `${trigger.kind}:${search ?? ""}`;
  const sentKey = useDebouncedValue(wanted, 250);
  // A switch between `@` and `#` asks at once; only a changing search waits for the debounce.
  const sent =
    trigger !== null && sentKey?.startsWith(`${trigger.kind}:`)
      ? sentKey.slice(trigger.kind.length + 1)
      : search;
  const hosted = useAtomValue(
    completionOptionsFamily(
      JSON.stringify(
        trigger === null
          ? null
          : {
              environmentId: EnvironmentId.make(input.environmentId),
              input: {
                kind: trigger.kind === "mention" ? "authors" : "references",
                projectId: ProjectId.make(input.projectId),
                ...(sent ? { query: sent } : {}),
              },
            },
      ),
    ),
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  const candidates: ReadonlyArray<PullRequestCompletion> =
    trigger === null
      ? []
      : trigger.kind === "mention"
        ? narrowPullRequestMentions(hosted.authors, trigger.query, COMPLETION_SUGGESTION_LIMIT).map(
            (actor) => ({ kind: "mention", token: `@${actor.login}`, actor }),
          )
        : narrowPullRequestReferences(hosted.references, trigger, COMPLETION_SUGGESTION_LIMIT).map(
            (candidate) => ({ kind: "reference", token: candidate.reference, candidate }),
          );

  return {
    kind: trigger?.kind ?? null,
    candidates,
    isLoading: hosted.waiting || sent !== search,
    failed: hosted.failed,
    selection: placed ?? undefined,
    onSelectionChange: (event: TextInputSelectionChangeEvent) => {
      setSelection(event.nativeEvent.selection);
      setPlaced(null);
    },
    onBlur: () => setSelection(null),
    select: (completion: PullRequestCompletion) => {
      if (trigger === null) return;
      const next = insertPullRequestCompletion(input.value, trigger, completion.token);
      input.onChangeValue(next.text);
      setSelection({ start: next.cursor, end: next.cursor });
      setPlaced({ start: next.cursor, end: next.cursor });
    },
  };
}
