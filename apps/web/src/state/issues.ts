import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type { EnvironmentId, IssueListInput, IssueListResult } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}

export interface MergedIssueListView {
  /** One answer per environment that has one, in target order. */
  readonly answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>;
  /** The first environment that failed outright; the others may still have answered. */
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/**
 * The same listing read across every connected environment at once, as the pull-request page
 * does: React cannot subscribe to a list of atoms whose length changes, so the fan-out lives in
 * one derived atom keyed by the targets. An environment that fails contributes nothing rather
 * than blanking the page.
 */
const mergedIssueListFamily = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as ReadonlyArray<IssueListTarget>;
    const answers: Array<readonly [EnvironmentId, IssueListResult]> = [];
    let error: string | null = null;
    let isPending = false;
    for (const target of targets) {
      const result = get(issueEnvironment.list(target));
      isPending ||= result.waiting;
      if (result._tag === "Failure" && error === null) {
        error = formatEnvironmentQueryError(result.cause);
      }
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) answers.push([target.environmentId, value]);
    }
    return { answers, error, isPending };
  }).pipe(Atom.withLabel(`web-issues:list:${key}`)),
);

const EMPTY_ISSUE_LIST = Atom.make({
  answers: [] as ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  error: null as string | null,
  isPending: false,
}).pipe(Atom.withLabel("web-issues:list:empty"));

export function useIssueList(targets: ReadonlyArray<IssueListTarget>): MergedIssueListView {
  const key = JSON.stringify(targets);
  const view = useAtomValue(targets.length === 0 ? EMPTY_ISSUE_LIST : mergedIssueListFamily(key));
  const refresh = useCallback(() => {
    for (const target of JSON.parse(key) as ReadonlyArray<IssueListTarget>) {
      appAtomRegistry.refresh(issueEnvironment.list(target));
    }
  }, [key]);
  return { ...view, refresh };
}
