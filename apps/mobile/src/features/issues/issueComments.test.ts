import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as RpcClient from "../../../../../packages/client-runtime/src/rpc/client";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  IssueTrackerKind,
  type AuthSessionState,
  type IssueReactionInput,
  type IssueReactionContent,
  ProjectId,
  type IssueComment,
  type IssueDetail,
} from "@t3tools/contracts";
import {
  appendOlderIssueComments,
  issueCommentsView,
  reactOnOlderIssueComment,
  confirmIssueReaction,
  issueReactionsView,
  type IssueConfirmedReactions,
} from "./issueComments";

import { issueAccess, issueReactionAllowed } from "./issueDetail";

const comment = (id: string, reactions?: IssueComment["reactions"]): IssueComment => ({
  id,
  author: null,
  body: id,
  createdAt: "2026-10-01T00:00:00Z",
  url: null,
  ...(reactions === undefined ? {} : { reactions }),
});

function detail(patch: Partial<IssueDetail> = {}): IssueDetail {
  return {
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
    displayKey: "#1",
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    title: "Issue",
    url: "https://example.com/issue",
    author: null,
    state: { category: "open", name: "Open" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 3,
    writable: true,
    viewer: "viewer",
    body: "",
    comments: [comment("c3")],
    commentsCursor: "page-2",
    events: [],
    linkedPullRequests: [],
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: true,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    ...patch,
  };
}

const heart = [{ content: "heart" as const, count: 1, actors: [], viewerHasReacted: false }];

describe("older issue comments across detail re-reads", () => {
  const first = detail();
  const loaded = appendOlderIssueComments(first, null, {
    comments: [comment("c2", heart)],
    nextCursor: "page-3",
  });

  it("keeps loaded pages when a new detail has the same first-page IDs and cursor", () => {
    const refreshed = detail({
      title: "Renamed",
      comments: [{ ...comment("c3", heart), body: "Updated" }],
    });
    const view = issueCommentsView(refreshed, loaded);
    expect(view.held).toBe(loaded);
    expect(view.comments.map((each) => each.id)).toEqual(["c2", "c3"]);
    expect(view.comments[1]).toEqual(refreshed.comments[0]);
    expect(view.cursor).toBe("page-3");
  });

  it("restarts a shifted Jira head with the same offset and eventually includes every boundary comment", () => {
    const comments = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => comment(String(from + index)));
    const before = detail({
      tracker: IssueTrackerKind.make("jira"),
      host: "workspace.atlassian.net",
      scope: "PROJ",
      comments: comments(101, 150),
      commentsCursor: "50",
      commentCount: 150,
    });
    const loaded = appendOlderIssueComments(before, null, {
      comments: comments(51, 100),
      nextCursor: "100",
    });
    const after = { ...before, comments: comments(102, 151), commentCount: 151 };
    const shifted = issueCommentsView(after, loaded);
    expect(shifted.held).toBeNull();
    expect(shifted.cursor).toBe("50");
    expect(shifted.comments).toHaveLength(50);
    const page2 = appendOlderIssueComments(after, shifted.held, {
      comments: comments(52, 101),
      nextCursor: "100",
    });
    const page3 = appendOlderIssueComments(after, page2, {
      comments: comments(2, 51),
      nextCursor: "150",
    });
    const page4 = appendOlderIssueComments(after, page3, {
      comments: comments(1, 1),
      nextCursor: null,
    });
    const complete = issueCommentsView(after, page4);
    expect(complete.comments.map((each) => each.id)).toEqual(
      comments(1, 151).map((each) => each.id),
    );
    expect(complete.cursor).toBeNull();
  });

  it("drops them when the first page now ends elsewhere or the issue is another one", () => {
    const moved = issueCommentsView(detail({ commentsCursor: "page-2b" }), loaded);
    expect(moved.comments.map((each) => each.id)).toEqual(["c3"]);
    expect(moved.cursor).toBe("page-2b");
    const other = issueCommentsView(detail({ key: "2" }), loaded);
    expect(other.comments.map((each) => each.id)).toEqual(["c3"]);
  });

  it("drops another viewer's loaded pages so their reactions are not shown as this viewer's", () => {
    const mine = [{ ...heart[0]!, viewerHasReacted: true }];
    const asA = detail({ viewer: "a" });
    const loadedByA = appendOlderIssueComments(asA, null, {
      comments: [comment("c_old", mine)],
      nextCursor: null,
    });
    expect(issueCommentsView({ ...asA }, loadedByA).held).toBe(loadedByA);
    const asB = issueCommentsView(detail({ viewer: "b" }), loadedByA);
    expect(asB.held).toBeNull();
    expect(asB.comments.map((each) => each.id)).toEqual(["c3"]);
    expect(asB.cursor).toBe("page-2");
    const unknown = detail({ viewer: null });
    const loadedUnknown = appendOlderIssueComments(unknown, null, {
      comments: [comment("c_old", mine)],
      nextCursor: null,
    });
    expect(issueCommentsView({ ...unknown }, loadedUnknown).held).toBe(loadedUnknown);
    expect(issueCommentsView(detail({ viewer: "b" }), loadedUnknown).held).toBeNull();
  });

  it.each(["viewer", null])(
    "keeps cached older comments and fences a new unknown-owner first page: %s",
    (viewer) => {
      const before = detail({ viewer });
      const loaded = appendOlderIssueComments(before, null, {
        comments: [comment("c2", [{ ...heart[0]!, viewerHasReacted: true }])],
        nextCursor: null,
      });
      expect(issueCommentsView({ ...before }, loaded).held).toBe(loaded);
      const after = { ...before, comments: [...before.comments] };
      const fresh = issueCommentsView(after, loaded);
      expect(fresh.comments.map((each) => each.id)).toEqual(
        viewer === null ? ["c3"] : ["c2", "c3"],
      );
      expect(fresh.cursor).toBe(viewer === null ? "page-2" : null);
      if (viewer !== null) return;
      const reloaded = appendOlderIssueComments(after, fresh.held, {
        comments: [comment("c2", heart)],
        nextCursor: null,
      });
      expect(issueCommentsView(after, reloaded).comments[0]?.reactions).toEqual(heart);
      expect(issueCommentsView({ ...after }, reloaded).cursor).toBeNull();
    },
  );

  it("shows a confirmed reaction on a held comment so the next tap removes it", () => {
    const reacted = reactOnOlderIssueComment(loaded, "c2", "heart", true);
    expect(issueCommentsView(first, reacted).comments[0]?.reactions).toEqual([
      { content: "heart", count: 2, actors: [], viewerHasReacted: true },
    ]);
    const refreshed = detail({ comments: [comment("c3", heart)] });
    expect(issueCommentsView(refreshed, reacted).held).toBe(reacted);
    const undone = reactOnOlderIssueComment(reacted, "c2", "heart", false);
    expect(issueCommentsView(first, undone).comments[0]?.reactions).toEqual(heart);
    const added = reactOnOlderIssueComment(loaded, "c2", "rocket", true);
    expect(added.comments[0]?.reactions?.map((each) => each.content)).toEqual(["heart", "rocket"]);
  });
});

const environmentId = EnvironmentId.make("environment");
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);
vi.mock("../../../../../packages/client-runtime/src/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));

describe("confirmed mobile issue reactions", () => {
  const first = detail({ reactions: heart, comments: [comment("c3", heart)] });

  it("keeps confirmed issue and comment counts when the same issue is read again", () => {
    let held = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    held = confirmIssueReaction(environmentId, first, first.comments, held, "heart", true, "c3");
    const refreshed = detail({ reactions: [...heart], comments: [comment("c3", [...heart])] });
    const view = issueReactionsView(environmentId, refreshed, refreshed.comments, held);
    expect(view.reactions?.[0]).toMatchObject({ count: 2, viewerHasReacted: true });
    expect(view.comments[0]?.reactions?.[0]).toMatchObject({ count: 2, viewerHasReacted: true });
  });

  it("keeps the confirmed viewer flag when another person changes counts, then yields to native acknowledgement", () => {
    const held = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    const changed = detail({ reactions: [{ ...heart[0]!, count: 4 }], comments: first.comments });
    const view = issueReactionsView(environmentId, changed, changed.comments, held);
    expect(view.reactions?.[0]).toMatchObject({ count: 5, viewerHasReacted: true });
    const acknowledged = {
      ...changed,
      reactions: [{ ...heart[0]!, count: 6, viewerHasReacted: true }],
    };
    const native = issueReactionsView(
      environmentId,
      acknowledged,
      acknowledged.comments,
      view.held,
    );
    expect(native.reactions).toBe(acknowledged.reactions);
    expect(native.held).toBeNull();
  });

  it("drops a confirmation from another signed-in viewer, including one that lands after the switch", () => {
    const asA = detail({ reactions: heart, viewer: "a" });
    const held = confirmIssueReaction(environmentId, asA, asA.comments, null, "heart", true);
    expect(
      issueReactionsView(environmentId, { ...asA, reactions: [...heart] }, [], held).reactions?.[0],
    ).toMatchObject({ count: 2, viewerHasReacted: true });
    const asB = detail({ reactions: [{ ...heart[0]!, count: 2 }], viewer: "b" });
    const switched = issueReactionsView(environmentId, asB, asB.comments, held);
    expect(switched.reactions).toBe(asB.reactions);
    expect(switched.held).toBeNull();
    const late = confirmIssueReaction(environmentId, asA, asA.comments, null, "heart", false);
    const afterLate = issueReactionsView(environmentId, asB, asB.comments, late);
    expect(afterLate.reactions).toBe(asB.reactions);
    expect(afterLate.held).toBeNull();
    const unknown = detail({ reactions: heart, viewer: null });
    const unknownHeld = confirmIssueReaction(environmentId, unknown, [], null, "heart", true);
    expect(issueReactionsView(environmentId, { ...unknown }, [], unknownHeld).held).not.toBeNull();
  });

  it.each(
    [undefined, "c3"].flatMap((subjectId) =>
      ["viewer", null].flatMap((viewer) =>
        [false, true].map((reacted) => ({ subjectId, viewer, reacted })),
      ),
    ),
  )(
    "keeps cached reactions but trusts refreshed unknown owners: %j",
    ({ subjectId, viewer, reacted }) => {
      const reactions = [{ ...heart[0]!, count: 2, viewerHasReacted: !reacted }];
      const before = detail({ viewer, reactions, comments: [comment("c3", reactions)] });
      const held = confirmIssueReaction(
        environmentId,
        before,
        before.comments,
        null,
        "heart",
        reacted,
        subjectId,
      );
      const cached = { ...before, comments: [...before.comments] };
      const shown = issueReactionsView(environmentId, cached, cached.comments, held);
      expect(subjectId === undefined ? shown.reactions : shown.comments[0]?.reactions).toEqual([
        { ...heart[0]!, count: reacted ? 3 : 1, viewerHasReacted: reacted },
      ]);
      const native = [...reactions];
      const after = { ...before, reactions: native, comments: [comment("c3", native)] };
      const fresh = issueReactionsView(environmentId, after, after.comments, held);
      expect(subjectId === undefined ? fresh.reactions : fresh.comments[0]?.reactions).toEqual(
        viewer === null
          ? reactions
          : [{ ...heart[0]!, count: reacted ? 3 : 1, viewerHasReacted: reacted }],
      );
      expect(fresh.held).toBe(viewer === null ? null : held);
    },
  );

  it("holds a confirmed remove against a later add read and removes a last reaction", () => {
    const added = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    const removed = confirmIssueReaction(
      environmentId,
      first,
      first.comments,
      added,
      "heart",
      false,
    );
    const lateAdd = { ...first, reactions: [{ ...heart[0]!, count: 2, viewerHasReacted: true }] };
    expect(issueReactionsView(environmentId, lateAdd, lateAdd.comments, removed).reactions).toEqual(
      heart,
    );
    const onlyMine = { ...first, reactions: [{ ...heart[0]!, viewerHasReacted: true }] };
    const held = confirmIssueReaction(
      environmentId,
      onlyMine,
      onlyMine.comments,
      null,
      "heart",
      false,
    );
    expect(issueReactionsView(environmentId, onlyMine, onlyMine.comments, held).reactions).toEqual(
      [],
    );
  });

  it("keeps an older comment confirmation when a shifted first page requires loading its page again", () => {
    const older = appendOlderIssueComments(first, null, {
      comments: [comment("c2", heart)],
      nextCursor: null,
    });
    const loaded = issueCommentsView(first, older).comments;
    const held = confirmIssueReaction(environmentId, first, loaded, null, "heart", true, "c2");
    const shifted = { ...first, comments: [comment("c4", heart)] };
    const reset = issueCommentsView(shifted, older);
    const missing = issueReactionsView(environmentId, shifted, reset.comments, held);
    const reloaded = appendOlderIssueComments(shifted, reset.held, {
      comments: [comment("c2", [...heart])],
      nextCursor: null,
    });
    const shown = issueReactionsView(
      environmentId,
      shifted,
      issueCommentsView(shifted, reloaded).comments,
      missing.held,
    );
    expect(shown.comments.find((each) => each.id === "c2")?.reactions?.[0]).toMatchObject({
      count: 2,
      viewerHasReacted: true,
    });
  });

  it("reconciles each content and subject separately when native viewer flags arrive", () => {
    let held = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    held = confirmIssueReaction(environmentId, first, first.comments, held, "rocket", true);
    held = confirmIssueReaction(environmentId, first, first.comments, held, "heart", true, "c3");
    const native = { ...first, reactions: [{ ...heart[0]!, count: 2, viewerHasReacted: true }] };
    const view = issueReactionsView(environmentId, native, native.comments, held);
    expect(view.reactions).toEqual([
      ...native.reactions,
      { content: "rocket", count: 1, actors: [], viewerHasReacted: true },
    ]);
    expect(view.comments[0]?.reactions?.[0]).toMatchObject({ count: 2, viewerHasReacted: true });
    const removed = { ...native, reactions: heart };
    expect(
      issueReactionsView(environmentId, removed, removed.comments, view.held).reactions?.[0],
    ).toEqual(heart[0]);
  });

  it.each([
    { environmentId: EnvironmentId.make("other"), issue: first },
    { environmentId, issue: { ...first, key: "other" } },
    { environmentId, issue: { ...first, tracker: IssueTrackerKind.make("jira") } },
    { environmentId, issue: { ...first, projectId: ProjectId.make("other") } },
    { environmentId, issue: { ...first, host: "other.example" } },
    { environmentId, issue: { ...first, scope: "other/repo" } },
  ])("does not carry confirmed flags to another target %j", (target) => {
    const held = confirmIssueReaction(environmentId, first, first.comments, null, "heart", true);
    const view = issueReactionsView(
      target.environmentId,
      target.issue,
      target.issue.comments,
      held,
    );
    expect(view.reactions).toEqual(heart);
    expect(view.held).toBeNull();
  });
});

effectIt.effect.each(
  [undefined, "c3", "c2"].flatMap((subjectId) =>
    [false, true].flatMap((viewerHasReacted) =>
      [false, true].map((failRead) => ({ subjectId, viewerHasReacted, failRead })),
    ),
  ),
)(
  "sends the opposite reaction after a confirmed write with native reads delayed or failed %j",
  ({ subjectId, viewerHasReacted, failRead }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reactions = [{ ...heart[0]!, count: 2, viewerHasReacted }];
        const first = detail({ reactions, comments: [comment("c3", reactions)] });
        const older = appendOlderIssueComments(first, null, {
          comments: [comment("c2", reactions)],
          nextCursor: null,
        });
        const comments = issueCommentsView(first, older).comments;
        const refreshStarted = Latch.makeUnsafe();
        const releaseRead = Latch.makeUnsafe();
        const readFailed = Latch.makeUnsafe();
        const state = yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        });
        const session = yield* SubscriptionRef.make(Option.some({}));
        const supervisor = {
          state,
          session,
        } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        );
        const atoms = createIssueEnvironmentAtoms(runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const mountSession = registry.mount(sessions(environmentId));
        yield* Effect.addFinalizer(() => Effect.sync(mountSession));
        registry.set(
          sessions(environmentId),
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        let reads = 0;
        const read = vi.spyOn(RpcClient, "request");
        read.mockImplementation((() =>
          Effect.suspend(() => {
            reads++;
            if (reads === 1) return Effect.succeed(first);
            refreshStarted.openUnsafe();
            return releaseRead.await.pipe(
              Effect.andThen(
                failRead ? Effect.fail(new Error("detail read failed")) : Effect.succeed(first),
              ),
            );
          })) as unknown as Parameters<typeof read.mockImplementation>[0]);
        yield* Effect.addFinalizer(() => Effect.sync(() => read.mockRestore()));
        const calls: IssueReactionInput[] = [];
        let failWrite = false;
        const write = vi.spyOn(RpcClient, "requestGuarded");
        write.mockImplementation(((_tag: string, input: IssueReactionInput) =>
          Effect.sync(() => calls.push(input)).pipe(
            Effect.andThen(() =>
              failWrite ? Effect.fail(new Error("write failed")) : Effect.void,
            ),
          )) as unknown as Parameters<typeof write.mockImplementation>[0]);
        yield* Effect.addFinalizer(() => Effect.sync(() => write.mockRestore()));
        const target = {
          environmentId,
          input: {
            projectId: first.projectId,
            tracker: first.tracker,
            host: first.host,
            scope: first.scope,
            key: first.key,
          },
        };
        const query = atoms.detail(target);
        const stop = registry.subscribe(query, (result) => {
          if (result._tag === "Failure") readFailed.openUnsafe();
        });
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        let held: IssueConfirmedReactions | null = null;
        const shown = (input: { subjectId: string | undefined } = { subjectId }) => {
          const issue = Option.getOrThrow(AsyncResult.value(registry.get(query)));
          const view = issueReactionsView(
            environmentId,
            issue,
            issueCommentsView(issue, older).comments,
            held,
          );
          return input.subjectId === undefined
            ? view.reactions
            : view.comments.find((each) => each.id === input.subjectId)?.reactions;
        };
        let currentIssue = first;
        const toggle = (
          input: { content: IssueReactionContent; subjectId: string | undefined } = {
            content: "heart",
            subjectId,
          },
        ) =>
          Effect.promise(async () => {
            const access = issueAccess(currentIssue, {
              connected: true,
              comment: true,
              update: true,
              setState: true,
              react: true,
            });
            if (
              !issueReactionAllowed(currentIssue, access, input.content, input.subjectId, comments)
            )
              return null;
            const reacted = !shown(input)?.find((reaction) => reaction.content === "heart")
              ?.viewerHasReacted;
            const response = await runAtomCommand(
              registry,
              atoms.react,
              {
                ...target,
                input: {
                  ...target.input,
                  ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
                  content: input.content,
                  reacted,
                },
              },
              { reportFailure: false },
            );
            if (response._tag === "Success")
              held = confirmIssueReaction(
                environmentId,
                first,
                comments,
                held,
                input.content,
                reacted,
                input.subjectId,
              );
            return response;
          });
        expect((yield* toggle())?._tag).toBe("Success");
        yield* refreshStarted.await;
        if (failRead) {
          releaseRead.openUnsafe();
          yield* readFailed.await;
        }
        expect(shown()?.[0]).toMatchObject({
          viewerHasReacted: !viewerHasReacted,
          count: viewerHasReacted ? 1 : 3,
        });
        expect((yield* toggle())?._tag).toBe("Success");
        expect(calls.map((call) => call.reacted)).toEqual([!viewerHasReacted, viewerHasReacted]);
        expect(calls.map((call) => call.subjectId)).toEqual([subjectId, subjectId]);
        expect(shown()).toEqual(reactions);
        const beforeFailure = held;
        const beforeReads = reads;
        failWrite = true;
        expect((yield* toggle())?._tag).toBe("Failure");
        expect(held).toBe(beforeFailure);
        expect(shown()).toEqual(reactions);
        expect(reads).toBe(beforeReads);
        currentIssue = {
          ...first,
          capabilities: {
            ...first.capabilities,
            reactions: false,
            commentReactions: true,
            reactionContents: ["thumbs-up", "thumbs-down", "laugh", "hooray", "confused", "heart"],
          },
        };
        const beforeDenied = calls.length;
        failWrite = false;
        expect(yield* toggle({ content: "heart", subjectId: undefined })).toBeNull();
        expect(yield* toggle({ content: "rocket", subjectId: "c2" })).toBeNull();
        expect(yield* toggle({ content: "eyes", subjectId: "c3" })).toBeNull();
        expect(yield* toggle({ content: "heart", subjectId: "unknown" })).toBeNull();
        expect(calls).toHaveLength(beforeDenied);
        const azure = currentIssue;
        currentIssue = { ...azure, capabilities: { ...azure.capabilities, reactionContents: [] } };
        expect(yield* toggle({ content: "heart", subjectId: "c3" })).toBeNull();
        expect(calls).toHaveLength(beforeDenied);
        currentIssue = azure;
        expect((yield* toggle({ content: "heart", subjectId: "c3" }))?._tag).toBe("Success");
        expect((yield* toggle({ content: "heart", subjectId: "c2" }))?._tag).toBe("Success");
        expect(calls.slice(beforeDenied).map((call) => [call.content, call.subjectId])).toEqual([
          ["heart", "c3"],
          ["heart", "c2"],
        ]);
      }),
    ),
);
