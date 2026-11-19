/* oxlint-disable t3code/no-untranslated-copy -- fixture data in the server's wire form, never shown in a release build */
import {
  PullRequestActivity,
  PullRequestDetail,
  PullRequestDiffResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

// Design and screenshot data only: with `EXPO_PUBLIC_CONN_TASKS_FIXTURE=1` at build time, the
// fixture task's pull request opens this one, decoded through the real schemas. It mirrors the
// approved iPhone mockup (Tasks and PR screens, 2026-11-19).
const USE_FIXTURES = process.env.EXPO_PUBLIC_CONN_TASKS_FIXTURE === "1";

const FIXTURE_ENVIRONMENT = "fixture-pull-requests";
const MINUTE = 60_000;
const NUMBER = 1931;
const URL = `https://github.com/nckrtl/conn/pull/${NUMBER}`;

const actor = (login: string, isBot = false) => ({ login, name: null, avatarUrl: null, isBot });

const FILES: ReadonlyArray<{ path: string; added: number; removed: number }> = [
  { path: "apps/web/src/components/chat/ComposerAttachments.tsx", added: 312, removed: 40 },
  { path: "apps/web/src/components/chat/ComposerSurface.tsx", added: 88, removed: 21 },
  { path: "apps/web/src/components/chat/ComposerAttachments.test.tsx", added: 120, removed: 0 },
  { path: "apps/mobile/src/features/threads/ComposerAttachmentButton.tsx", added: 96, removed: 52 },
  {
    path: "packages/client-runtime/src/attachments/providerImageLimits.ts",
    added: 142,
    removed: 0,
  },
  {
    path: "packages/client-runtime/src/attachments/providerImageLimits.test.ts",
    added: 84,
    removed: 0,
  },
];

const patch = () =>
  FILES.map(({ path, added, removed }) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${removed} +1,${added} @@`,
      ...Array.from({ length: removed }, (_, index) => `-// removed line ${index + 1}`),
      ...Array.from({ length: added }, (_, index) => `+// added line ${index + 1}`),
    ].join("\n"),
  ).join("\n");

const decodeDetail = Schema.decodeSync(PullRequestDetail);
const decodeActivity = Schema.decodeSync(PullRequestActivity);
const decodeDiff = Schema.decodeSync(PullRequestDiffResult);

function detail(now: number) {
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  return decodeDetail({
    provider: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: ["squash"],
      search: false,
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
    },
    viewerPermissions: {
      actions: [],
      comment: false,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    },
    projectId: "fixture-conn",
    projectTitle: "conn",
    workspaceRoot: "/fixture/conn",
    repository: "nckrtl/conn",
    number: NUMBER,
    title: "feat(web): attach images in the composer",
    body: "Attach images in the composer on desktop and iOS.\n\n- Chips above the input, one per image.\n- A warning when the selected model cannot read images.\n- The iOS photo picker from the attachment button.",
    url: URL,
    author: actor("orbit-bot", true),
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 842,
    deletions: 113,
    changedFiles: FILES.length,
    headBranch: "orbit/482-image-attachments",
    baseBranch: "main",
    createdAt: ago(60),
    updatedAt: ago(4),
    mergedAt: null,
    closedAt: null,
    reviewers: [actor("nckrtl")],
    labels: [{ name: "orbit", color: "8b5cf6" }],
    checks: [
      { name: "check:changed", status: "success", description: null, url: null },
      { name: "Browser tests", status: "pending", description: null, url: null },
      { name: "Typecheck", status: "success", description: null, url: null },
      { name: "Unit tests", status: "success", description: null, url: null },
      { name: "Deploy web preview", status: "skipped", description: null, url: null },
    ],
    mergeCapabilities: { merge: false, squash: true, rebase: false },
  });
}

function activity(now: number) {
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  const commit = (oid: string, messageHeadline: string, minutes: number) => ({
    oid,
    messageHeadline,
    committedDate: ago(minutes),
    authors: [actor("orbit-bot", true)],
  });
  return decodeActivity({
    comments: [
      {
        id: "r1",
        kind: "review",
        author: actor("nckrtl"),
        body: "",
        createdAt: ago(6),
        url: `${URL}#pullrequestreview-1`,
        path: null,
        reviewState: "APPROVED",
        reactions: [
          { content: "rocket", count: 1, actors: ["orbit-bot"], viewerHasReacted: false },
        ],
      },
      {
        id: "c1",
        kind: "issue-comment",
        author: actor("nckrtl"),
        body: "Does the warning show before sending when the model cannot read images?",
        createdAt: ago(31),
        url: `${URL}#issuecomment-1`,
        path: null,
        reviewState: null,
      },
      {
        id: "c2",
        kind: "issue-comment",
        author: actor("orbit-bot"),
        body: "Yes: the chip shows a warning and Send stays enabled.",
        createdAt: ago(30),
        url: `${URL}#issuecomment-2`,
        path: null,
        reviewState: null,
      },
    ],
    commentCount: 3,
    commentsTruncated: false,
    reviewThreads: [
      {
        id: "t1",
        path: "apps/web/src/components/chat/ComposerAttachments.tsx",
        line: 142,
        side: "right",
        isResolved: false,
        isOutdated: true,
        comments: [
          {
            id: "t1c1",
            author: actor("coderabbitai"),
            body: "Removing a chip moves focus to the message body. Keep focus in the composer after a chip goes.",
            createdAt: ago(20),
            url: `${URL}#discussion_r1`,
          },
          {
            id: "t1c2",
            author: actor("nckrtl"),
            body: "Fixed in 9c04e21: focus stays in the composer.",
            createdAt: ago(12),
            url: `${URL}#discussion_r2`,
          },
        ],
      },
    ],
    commits: [
      commit("9c04e21a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e", "Keep focus after removing a chip", 9),
      commit(
        "71be2d4a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e",
        "Show attachment chips above the input",
        40,
      ),
      commit("3a91f0ca0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e", "Add provider image limits", 52),
    ],
  });
}

/** The screen params for the fixture pull request, when `url` is the fixture task's. */
export function fixturePullRequestParams(url: string) {
  if (!USE_FIXTURES || url !== URL) return null;
  return {
    environmentId: FIXTURE_ENVIRONMENT,
    projectId: "fixture-conn",
    repository: "nckrtl/conn",
    number: NUMBER,
  };
}

export const isFixturePullRequestEnvironment = (environmentId: string) =>
  USE_FIXTURES && environmentId === FIXTURE_ENVIRONMENT;

const now = Date.now();
const settled = <A>(value: A) => Atom.make(Effect.succeed(value)).pipe(Atom.keepAlive);
const FIXTURE_ATOMS = USE_FIXTURES
  ? {
      detail: settled(detail(now)),
      activity: settled(activity(now)),
      diff: settled(
        decodeDiff({
          patch: patch(),
          truncated: false,
          nextCursor: null,
        }),
      ),
    }
  : null;

type Target = { readonly environmentId: EnvironmentId };

/** Swaps the reads of the fixture pull request for its data; every other target reads as usual. */
export function withPullRequestFixtures<
  Atoms extends Record<"detail" | "activity" | "diff", unknown>,
>(atoms: Atoms): Atoms {
  const fixtures = FIXTURE_ATOMS;
  if (!fixtures) return atoms;
  const swap = <K extends keyof typeof fixtures>(key: K) =>
    ((target: Target) =>
      target.environmentId === FIXTURE_ENVIRONMENT
        ? fixtures[key]
        : (atoms[key] as (target: Target) => unknown)(target)) as unknown as Atoms[K];
  return { ...atoms, detail: swap("detail"), activity: swap("activity"), diff: swap("diff") };
}
