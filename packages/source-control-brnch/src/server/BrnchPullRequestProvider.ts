import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderKind,
  TrimmedNonEmptyString,
  type PullRequestCapabilities,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { definition } from "../client/definition.ts";
import * as BrnchCli from "./brnchCli.ts";
import * as Json from "./brnchChangeJson.ts";

const KIND = SourceControlProviderKind.make("brnch");

/**
 * What the `brnch` CLI can do with a change. It has no text search, no draft command, and no
 * patch of a whole change, so the Code tab, reviews, and reviewer requests are not offered.
 */
const CAPABILITIES: PullRequestCapabilities = {
  diff: false,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: false,
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: false, comment: false },
};

/** Rows per `change list` page. */
const PAGE_SIZE = 100;
/** Where `brnch merge request` stopped short; any other state is queued or done. */
const FAILED_PROMOTION_STATES = new Set(["blocked", "failed", "cancelled"]);

/** `brnch auth status`; the handle is what authors read under, so the two compare directly. */
const AuthStatus = Schema.Struct({
  user: Schema.Struct({
    id: TrimmedNonEmptyString,
    handle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  }),
});

/**
 * Brnch states no per-change permissions, so everything the change's state allows is offered and
 * Brnch's own refusal says why when the viewer may not.
 */
function viewerPermissions(change: Json.BrnchChange): PullRequestViewerPermissions {
  return {
    actions:
      change.state === "draft"
        ? ["ready", "close"]
        : change.state === "open"
          ? ["merge", "close"]
          : change.state === "closed"
            ? ["reopen"]
            : [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
    updateMethods: [],
    editChangeRequest: false,
  };
}

type ChangeRef = ProviderRepositoryRef & { readonly number: number };

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const cli = yield* BrnchCli.make;

  const failure = (operation: string, detail: string) =>
    new PullRequestProviderError({ provider: KIND, operation, reason: "failed", detail });

  const brnch = <A>(
    operation: string,
    input: Pick<ProviderRepositoryRef, "cwd">,
    args: ReadonlyArray<string>,
    schema: Schema.Codec<A, unknown, never, never>,
    options: Pick<BrnchCli.BrnchRunInput, "stdin" | "resultExitCodes"> = {},
  ) =>
    cli.run({ operation, cwd: input.cwd, args, ...options }, schema).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: KIND,
            operation,
            reason: error.reason,
            detail: error.detail,
            cause: error,
          }),
      ),
    );

  /** `--repo` for a repository on brnch.io, refused before anything runs for any other host. */
  const repoArgs = (
    operation: string,
    input: ProviderRepositoryRef,
  ): Effect.Effect<ReadonlyArray<string>, PullRequestProviderError> =>
    input.host.toLowerCase() === BrnchCli.BRNCH_HOST &&
    BrnchCli.brnchRepositoryPath(input.repository) === input.repository
      ? Effect.succeed(["--repo", input.repository])
      : Effect.fail(failure(operation, "Brnch serves owner/name repositories on brnch.io."));

  const readChange = (operation: string, input: ChangeRef) =>
    repoArgs(operation, input).pipe(
      Effect.flatMap((repo) =>
        brnch(
          operation,
          input,
          ["change", "view", String(input.number), ...repo],
          Json.BrnchChange,
        ),
      ),
    );

  const unsupported = (operation: string) =>
    Effect.fail(failure(operation, `Brnch cannot ${operation} from T3 Code yet.`));

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    getViewer: (input) =>
      brnch("getViewer", input, ["auth", "status"], AuthStatus).pipe(
        Effect.map((status) => status.user.handle ?? status.user.id),
      ),
    /**
     * Brnch's cursors are opaque and one list per state, while the service pages by rows
     * delivered, so each read walks its lists from the top to the slice asked for. Lists arrive
     * newest first and the slice keeps that order, so a list read as far as the slice's end
     * contributes everything that can fall inside it. The CLI has no author filter, so the
     * viewer's own changes are picked out while walking, before rows count toward the slice.
     */
    listChangeRequests: Effect.fn("BrnchPullRequestProvider.listChangeRequests")(function* (input) {
      const repo = yield* repoArgs("listChangeRequests", input);
      // Brnch names no reviewers on a change, so nothing is under review by the viewer.
      if (input.involvement === "reviewing")
        return { items: [], truncated: false, continues: false };
      const wanted = (change: Json.BrnchChange) =>
        input.involvement !== "authored" || Json.actorLogin(change.author) === input.viewer;
      const offset = input.cursor?.delivered ?? 0;
      const end = offset + Math.max(1, input.limit);
      // Brnch keeps drafts apart from open changes; both are open here.
      const states =
        input.state === "all" ? [null] : input.state === "open" ? ["open", "draft"] : [input.state];
      const lists = yield* Effect.forEach(
        states,
        Effect.fn(function* (state) {
          const items: Array<Json.BrnchChange> = [];
          let cursor: string | null = null;
          const cursors = new Set<string>();
          while (items.length < end) {
            const page: typeof Json.BrnchChanges.Type = yield* brnch(
              "listChangeRequests",
              input,
              [
                "change",
                "list",
                ...repo,
                "--limit",
                String(PAGE_SIZE),
                ...(state === null ? [] : ["--state", state]),
                ...(cursor === null ? [] : ["--cursor", cursor]),
              ],
              Json.BrnchChanges,
            );
            items.push(...page.items.filter(wanted));
            if (page.next_cursor === null || cursors.has(page.next_cursor))
              return { items, more: false };
            cursors.add(page.next_cursor);
            cursor = page.next_cursor;
          }
          return { items, more: true };
        }),
        { concurrency: 2 },
      );
      const changes = lists
        .flatMap((list) => list.items)
        .toSorted((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const items = changes.slice(offset, end);
      return {
        items: items.map((change) => Json.toProviderChangeRequest(change, input.repository)),
        truncated: changes.length > end || lists.some((list) => list.more),
        continues: true,
        cursorAdvance: items.length,
      };
    }),
    getChangeRequest: Effect.fn("BrnchPullRequestProvider.getChangeRequest")(function* (input) {
      const repo = yield* repoArgs("getChangeRequest", input);
      const [change, files] = yield* Effect.all(
        [
          readChange("getChangeRequest", input),
          // The file list is what the CLI has of a change's size; it carries no line counts.
          brnch(
            "getChangeRequest",
            input,
            ["change", "diff", String(input.number), ...repo],
            Json.BrnchChangeFiles,
          ),
        ],
        { concurrency: 2 },
      );
      return {
        ...Json.toProviderChangeRequest(change, input.repository),
        headSha: change.current_revision.head_oid,
        body: change.description,
        changedFiles: files.files.length,
        mergedAt: change.merged?.at ?? null,
        closedAt: null,
        reviewers: [],
        checks: [],
        mergeCapabilities: { merge: true, squash: true, rebase: true },
        viewerPermissions: viewerPermissions(change),
      };
    }),
    getChangeRequestActivity: Effect.fn("BrnchPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const repo = yield* repoArgs("getChangeRequestActivity", input);
        const threads = yield* brnch(
          "getChangeRequestActivity",
          input,
          ["review", "threads", String(input.number), ...repo, "--limit", String(PAGE_SIZE)],
          Json.BrnchThreads,
        );
        return Json.toActivity(threads);
      },
    ),
    getViewerPermissions: (input) =>
      readChange("getViewerPermissions", input).pipe(Effect.map(viewerPermissions)),
    getDiff: () => unsupported("getDiff"),
    runAction: Effect.fn("BrnchPullRequestProvider.runAction")(function* (input) {
      const repo = yield* repoArgs(input.action, input);
      const number = String(input.number);
      switch (input.action) {
        case "ready":
        case "close":
        case "reopen":
          yield* brnch(
            input.action,
            input,
            ["change", input.action, number, ...repo],
            Json.BrnchChange,
          );
          return;
        case "merge": {
          // A blocked promotion exits 7 with the promotion as its answer, blockers included.
          const promotion = yield* brnch(
            "merge",
            input,
            ["merge", "request", number, ...repo, "--strategy", input.mergeMethod ?? "merge"],
            Json.BrnchPromotion,
            { resultExitCodes: [7] },
          );
          if (FAILED_PROMOTION_STATES.has(promotion.state))
            return yield* failure(
              "merge",
              promotion.blockers.map((blocker) => blocker.message).join(" ") ||
                promotion.error ||
                `Brnch's merge was ${promotion.state}.`,
            );
          return;
        }
        default:
          return yield* unsupported(input.action);
      }
    }),
    // A remark on the change itself, which does not hold up its merge as a review thread would.
    comment: Effect.fn("BrnchPullRequestProvider.comment")(function* (input) {
      const repo = yield* repoArgs("comment", input);
      yield* brnch(
        "comment",
        input,
        ["review", "comment", String(input.number), ...repo, "--body", "-", "--non-blocking"],
        Schema.Unknown,
        { stdin: input.body },
      );
    }),
    submitReview: () => unsupported("submitReview"),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    replyToThread: () => unsupported("replyToThread"),
    setReaction: () => unsupported("setReaction"),
    setThreadResolution: () => unsupported("setThreadResolution"),
  };
  return provider;
});
