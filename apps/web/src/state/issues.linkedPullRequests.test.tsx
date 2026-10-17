import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  type IssueLinkedPullRequest,
  type IssueLinkedPullRequestsPage,
} from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement, useEffect } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../hooks/useIssueViewRefresh", () => ({ useIssueViewRefresh: () => {} }));
vi.mock("@t3tools/client-runtime/state/issues", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const pages = Atom.family((_key: string) => {
    const value = Atom.make<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>(
      AsyncResult.success({ items: [], nextCursor: null }),
    ).pipe(Atom.keepAlive);
    return Atom.writable(
      (get) => get(value),
      (get, result: AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>) =>
        get.set(value, result),
      () => undefined,
    ).pipe(Atom.keepAlive);
  });
  return {
    createIssueEnvironmentAtoms: () => ({
      linkedPullRequests: (target: unknown) => pages(JSON.stringify(target)),
    }),
  };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import { issueEnvironment, useIssueLinkedPullRequests, type IssuePagedView } from "./issues";

const environmentId = EnvironmentId.make("environment");
let input = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "1",
};
let root: ReactTestRenderer | undefined;
let view: IssuePagedView<IssueLinkedPullRequest>;
function Probe() {
  const current = useIssueLinkedPullRequests(environmentId, input);
  useEffect(() => {
    view = current;
  }, [current]);
  return null;
}
const setPage = (cursor: string | undefined, value: IssueLinkedPullRequestsPage) =>
  appAtomRegistry.set(
    issueEnvironment.linkedPullRequests({
      environmentId,
      input: cursor === undefined ? input : { ...input, cursor },
    }) as Atom.Writable<AsyncResult.AsyncResult<IssueLinkedPullRequestsPage, unknown>>,
    AsyncResult.success(value),
  );
const link: IssueLinkedPullRequest = {
  repository: "org/repo",
  number: 50,
  title: "Fix",
  url: "https://github.com/org/repo/pull/50",
  state: "merged",
  isDraft: false,
  closesIssue: true,
};
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});

it.each(["github", "gitlab", "enterprise"])(
  "keeps one closing PR when the %s related page repeats it",
  async (tracker) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    input = {
      ...input,
      tracker: IssueTrackerKind.make(tracker === "enterprise" ? "github" : tracker),
      host: tracker === "enterprise" ? "code.internal" : `${tracker}.com`,
      key: tracker,
    };
    const closing = {
      ...link,
      url:
        tracker === "github"
          ? link.url
          : tracker === "enterprise"
            ? "https://code.internal/org/repo/pull/50"
            : "https://gitlab.com/org/repo/-/merge_requests/50",
    };
    setPage(undefined, { items: [closing], nextCursor: "related" });
    setPage("related", {
      items: [
        {
          ...closing,
          title: "Updated title",
          url: `${closing.url}#discussion`,
          closesIssue: false,
        },
      ],
      nextCursor: "related:2",
    });
    setPage("related:2", {
      items: [{ ...closing, number: 51, url: closing.url.replace("50", "51"), closesIssue: false }],
      nextCursor: null,
    });
    await act(async () => {
      root = create(
        createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
      );
    });
    await act(async () => view.loadMore());
    expect(view.items).toEqual([
      { ...closing, title: "Updated title", url: `${closing.url}#discussion`, closesIssue: true },
    ]);
    expect(view.hasMore).toBe(true);
    await act(async () => view.loadMore());
    expect(view.items.map(({ number, closesIssue }) => ({ number, closesIssue }))).toEqual([
      { number: 50, closesIssue: true },
      { number: 51, closesIssue: false },
    ]);
    expect(view.hasMore).toBe(false);
  },
);

it("preserves native providers, hosts, repositories, Forgejo mounts and ports", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  input = { ...input, tracker: IssueTrackerKind.make("linear"), host: "linear.app", key: "ENG-1" };
  const forgejo = {
    ...link,
    provider: SourceControlProviderKind.make("forgejo"),
    host: "code.example",
    url: "https://code.example/one/org/repo/pulls/50",
  };
  const links = [
    forgejo,
    { ...forgejo, url: "https://code.example/two/org/repo/pulls/50" },
    { ...forgejo, url: "https://code.example:8443/one/org/repo/pulls/50" },
    { ...forgejo, host: "other.example", url: "https://other.example/one/org/repo/pulls/50" },
    { ...forgejo, repository: "org/other", url: "https://code.example/one/org/other/pulls/50" },
    { ...forgejo, provider: SourceControlProviderKind.make("github") },
  ];
  setPage(undefined, { items: links, nextCursor: "duplicates" });
  setPage("duplicates", {
    items: links.map((item) => ({ ...item, closesIssue: false })),
    nextCursor: null,
  });
  await act(async () => {
    root = create(
      createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
    );
  });
  await act(async () => view.loadMore());
  expect(view.items).toEqual(links);
  expect(view.hasMore).toBe(false);
});

it("keeps Forgejo mount case while merging native owner/repo aliases across pages", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  input = { ...input, tracker: IssueTrackerKind.make("linear"), host: "linear.app", key: "ENG-2" };
  const upper = {
    ...link,
    provider: SourceControlProviderKind.make("forgejo"),
    host: "code.example",
    url: "https://code.example/Mount/org/repo/pulls/50",
  };
  const lower = {
    ...upper,
    url: "https://code.example/mount/org/repo/pulls/50",
    closesIssue: false,
  };
  const updated = [upper, lower].map((item) => ({
    ...item,
    url: item.url.replace("org/repo", "ORG/Repo") + "#discussion",
    closesIssue: false,
  }));
  setPage(undefined, { items: [upper, lower], nextCursor: "related" });
  setPage("related", { items: updated, nextCursor: "empty" });
  setPage("empty", { items: [], nextCursor: null });
  await act(async () => {
    root = create(
      createElement(RegistryContext.Provider, { value: appAtomRegistry }, createElement(Probe)),
    );
  });
  expect(view.items).toEqual([upper, lower]);
  await act(async () => view.loadMore());
  expect(view.items).toEqual([{ ...updated[0], closesIssue: true }, updated[1]]);
  expect(view.hasMore).toBe(true);
  await act(async () => view.loadMore());
  expect(view.items).toEqual([{ ...updated[0], closesIssue: true }, updated[1]]);
  expect(view.hasMore).toBe(false);
});
