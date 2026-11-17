import { expect, it, vi } from "vite-plus/test";
import type { ReviewDraft } from "./pullRequestReviewDrafts";

const mocks = vi.hoisted(() => ({
  draft: null as ReviewDraft | null,
  flush: vi.fn<() => Promise<boolean>>(),
  retire: vi.fn(),
  remove: vi.fn(),
  alert: vi.fn(),
  refresh: vi.fn(),
  copy: vi.fn(),
  retired: new Set<string>(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("../../state/pull-requests", () => ({
  composerPullRequests: {
    detail: () => null,
    activity: () => null,
    saveDraftComment: { permissionAtom: () => null },
    discardDraftComment: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { viewer: "jake", capabilities: { review: { draftComment: true } } },
    error: null,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.remove }));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: unknown) => ({ environmentId: "environment", input: params }),
}));
vi.mock("./usePullRequestReviewDraft", () => ({
  readReviewDraft: () => mocks.draft!,
  retireReviewDraftComments: (...args: unknown[]) => {
    mocks.retire(...args);
    mocks.retired.add("hosted");
  },
  isReviewDraftCommentRetired: (_scope: unknown, id: string) => mocks.retired.has(id),
  setReviewDraftBusy: () => true,
  usePullRequestReviewDraftCommands: () => ({
    ready: true,
    isReady: () => true,
    busy: false,
    complete: (transform: (draft: ReviewDraft) => ReviewDraft) => {
      mocks.draft = transform(mocks.draft!);
    },
    flush: mocks.flush,
  }),
}));

import { usePendingReviewCommentActions } from "./usePendingReviewCommentActions";

function setup() {
  const comment = {
    id: "local",
    path: "file.ts",
    position: { kind: "added" as const, newLine: 1 },
    body: "Private feedback",
    headSha: "head",
    code: "line",
    hostedComment: { reviewId: "review", commentId: "hosted", url: "https://host/comment" },
  };
  mocks.draft = { summary: "", comment: "", comments: [comment] };
  mocks.flush.mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
  mocks.remove.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.retire.mockClear();
  mocks.alert.mockClear();
  mocks.refresh.mockClear();
  mocks.copy.mockClear();
  mocks.retired.clear();
  return {
    comment,
    actions: usePendingReviewCommentActions({
      environmentId: "environment",
      projectId: "project",
      repository: "org/repo",
      number: 1,
    }),
  };
}

it("keeps a hosted discard recoverable when device persistence fails", async () => {
  const { comment, actions } = setup();
  expect(await actions.discard(comment)).toBe(false);
  expect(mocks.draft?.comments).toEqual([]);
  expect(mocks.retire).toHaveBeenCalledOnce();
  expect(mocks.alert).toHaveBeenCalledWith(
    "Could not discard the pending comment",
    expect.stringContaining("this device could not save the draft"),
  );
  expect(await actions.discard(comment)).toBe(true);
  expect(mocks.draft?.comments).toEqual([]);
  expect(mocks.retire).toHaveBeenCalledOnce();
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});

it("saves a hosted identity before copying its link and retries only local persistence", async () => {
  const { comment, actions } = setup();
  const { hostedComment, ...local } = comment;
  mocks.draft = { ...mocks.draft!, comments: [local] };
  mocks.remove.mockResolvedValue({ _tag: "Success", value: hostedComment });
  await actions.copyLink(local);
  expect(mocks.copy).not.toHaveBeenCalled();
  expect(mocks.draft!.comments[0]?.hostedComment).toEqual(hostedComment);
  expect(mocks.alert).toHaveBeenCalledWith(
    "Could not copy the pending comment link",
    expect.stringContaining("could not save"),
  );
  await actions.copyLink(local);
  expect(mocks.remove).toHaveBeenCalledOnce();
  expect(mocks.flush).toHaveBeenCalledTimes(2);
  expect(mocks.copy).toHaveBeenCalledWith(hostedComment.url);
});
