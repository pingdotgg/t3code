import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import { issueScopeKeyOf } from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueListInput,
  IssueDependenciesInput,
  IssuePageRef,
  IssueLinkedPullRequest,
  ProjectId,
} from "@t3tools/contracts";
import {
  changeRequestRepositoryUrl,
  parseChangeRequestUrl,
} from "@t3tools/shared/changeRequestUrl";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { useIssueViewRefresh } from "../hooks/useIssueViewRefresh";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  createMergedEnvironmentQuery,
  type EnvironmentQueryTarget,
} from "./mergedEnvironmentQuery";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export type IssueListTarget = EnvironmentQueryTarget<IssueListInput>;

export const useIssueList = createMergedEnvironmentQuery(
  "web-issues:list",
  (target: IssueListTarget) => issueEnvironment.list(target),
);

interface IssueQueryAnswer<A> {
  readonly value: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

const EMPTY_ANSWERS = Atom.make<ReadonlyArray<IssueQueryAnswer<never>>>([]).pipe(
  Atom.withLabel("web-issues:answers:empty"),
);

function createIssueQueries<Input, A>(
  label: string,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get) =>
      (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>).map(
        (target): IssueQueryAnswer<A> => {
          const result = get(atomFor(target));
          return {
            value: Option.getOrNull(AsyncResult.value(result)),
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            isPending: result.waiting || result._tag === "Initial",
          };
        },
      ),
    ).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  return function useIssueQueries(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const key = JSON.stringify(targets);
    const answers = useAtomValue(
      targets.length === 0
        ? (EMPTY_ANSWERS as unknown as Atom.Atom<ReadonlyArray<IssueQueryAnswer<A>>>)
        : family(key),
    );
    const refresh = () => {
      const target = (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>)[0];
      if (target !== undefined) appAtomRegistry.refresh(atomFor(target));
    };
    return { answers, refresh };
  };
}

export interface IssuePagedView<T> {
  readonly items: ReadonlyArray<T>;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly refresh: () => void;
}

function createIssuePagedQuery<
  Input extends {
    readonly cursor?: string | undefined;
    readonly projectId?: ProjectId | undefined;
  },
  A,
  T,
  Extra = undefined,
>(
  label: string,
  family: (target: EnvironmentQueryTarget<Input>) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  page: (value: A) => {
    readonly items: ReadonlyArray<T>;
    readonly nextCursor: string | null;
    readonly truncated?: boolean | undefined;
  },
  extra: (first: A | null) => Extra = () => undefined as Extra,
) {
  const useQueries = createIssueQueries(label, family);
  return function useIssuePages(
    environmentId: EnvironmentId | null,
    input: Input | null,
  ): IssuePagedView<T> & { readonly extra: Extra } {
    const key =
      environmentId === null || input === null ? "" : JSON.stringify([environmentId, input]);
    const [cursors, setCursors] = useState<{
      key: string;
      seed: A | null;
      values: ReadonlyArray<string>;
    }>({
      key,
      seed: null,
      values: [],
    });
    const values = cursors.key === key ? cursors.values : [];
    const { answers, refresh } = useQueries(
      environmentId === null || input === null
        ? []
        : [undefined, ...values].map((cursor) => ({
            environmentId,
            input: cursor === undefined ? input : { ...input, cursor },
          })),
    );
    const first = answers[0]?.value ?? null;
    const refreshPages = () => {
      setCursors({ key, seed: first, values: [] });
      refresh();
    };
    useIssueViewRefresh(
      refreshPages,
      environmentId === null || input === null ? [] : [{ environmentId, input }],
      key,
    );
    const retained = cursors.seed === first;
    if (values.length > 0 && !retained) setCursors({ key, seed: first, values: [] });
    const activeAnswers = retained ? answers : answers.slice(0, 1);
    const pages = activeAnswers.map((answer) =>
      answer.value === null ? null : page(answer.value),
    );
    const last = activeAnswers.at(-1);
    const nextCursor = last?.error == null ? (pages.at(-1)?.nextCursor ?? null) : null;
    const failedCursor =
      last?.error !== null && last?.error !== undefined ? values.at(-1) : undefined;
    return {
      items: pages.flatMap((entry) => entry?.items ?? []),
      truncated: pages.some((entry) => entry?.truncated === true),
      hasMore: failedCursor !== undefined || (nextCursor !== null && !values.includes(nextCursor)),
      isPending: activeAnswers.some((answer) => answer.isPending),
      error: activeAnswers.find((answer) => answer.error !== null)?.error ?? null,
      extra: extra(answers[0]?.value ?? null),
      loadMore: () => {
        if (last?.isPending) return;
        if (failedCursor !== undefined && environmentId !== null && input !== null) {
          appAtomRegistry.refresh(
            family({ environmentId, input: { ...input, cursor: failedCursor } }),
          );
          return;
        }
        if (nextCursor === null || values.includes(nextCursor) || last?.isPending) return;
        if (environmentId !== null && input !== null)
          appAtomRegistry.refresh(
            family({ environmentId, input: { ...input, cursor: nextCursor } }),
          );
        setCursors({ key, seed: first, values: [...values, nextCursor] });
      },
      refresh: refreshPages,
    };
  };
}

const pageOf = <P>(value: P) => value;

export const useIssueHistory = createIssuePagedQuery(
  "web-issues:history",
  issueEnvironment.history,
  pageOf,
);
export const useIssueComments = createIssuePagedQuery(
  "web-issues:comments",
  issueEnvironment.commentPages,
  (value) => ({ items: value.comments, nextCursor: value.nextCursor }),
);
const useLinkedPullRequestPages = createIssuePagedQuery(
  "web-issues:linked-pull-requests",
  issueEnvironment.linkedPullRequests,
  pageOf,
);
export function useIssueLinkedPullRequests(
  environmentId: EnvironmentId | null,
  input: IssuePageRef | null,
) {
  const page = useLinkedPullRequestPages(environmentId, input);
  const links = new Map<string, IssueLinkedPullRequest>();
  for (const link of page.items) {
    const parsed = parseChangeRequestUrl(link.url);
    const provider = link.provider ?? input?.tracker;
    const repositoryUrl = provider === "forgejo" ? changeRequestRepositoryUrl(link.url) : null;
    const repository =
      repositoryUrl === null
        ? (parsed?.repository ?? link.repository)
        : new URL(repositoryUrl).pathname.slice(1);
    let host = link.host?.toLowerCase() ?? link.url;
    try {
      host = new URL(link.url).host.toLowerCase() || host;
    } catch {}
    const key = JSON.stringify([
      provider,
      host,
      issueScopeKeyOf({ tracker: provider ?? "", scope: repository }),
      link.number,
    ]);
    links.set(key, {
      ...link,
      closesIssue: link.closesIssue || links.get(key)?.closesIssue === true,
    });
  }
  return { ...page, items: [...links.values()] };
}
export const useIssueHierarchy = createIssuePagedQuery(
  "web-issues:hierarchy",
  issueEnvironment.hierarchy,
  (value) => value.children,
  (first) => first?.parent ?? null,
);
export const useIssueLabelCandidates = createIssuePagedQuery(
  "web-issues:label-candidates",
  issueEnvironment.labelCandidates,
  pageOf,
);
export const useIssueAssigneeCandidates = createIssuePagedQuery(
  "web-issues:assignee-candidates",
  issueEnvironment.assigneeCandidates,
  pageOf,
);

const useDependencyPages = createIssuePagedQuery(
  "web-issues:dependencies",
  issueEnvironment.dependencies,
  pageOf,
);
export function useIssueDependencies(environmentId: EnvironmentId, input: IssueDependenciesInput) {
  const page = useDependencyPages(environmentId, input);
  const items = new Map<string, (typeof page.items)[number]>();
  for (const item of page.items) items.set(JSON.stringify([item.kind, item.scope, item.key]), item);
  return { ...page, items: [...items.values()] };
}
