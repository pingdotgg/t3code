import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { resolvePullRequestAuthorFilter, type PullRequestListFilters } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeHosts from "./gitCafeHosts.ts";
import * as Json from "./gitCafePullRequestJson.ts";

import {
  PAGE_SIZE,
  MAX_PAGES,
  KNOWN_AUTHORS_LIMIT,
  DIFF_FILES_BATCH,
  CHANGES_PAGE_LIMIT,
  LINE_STATS_MAX_FILES,
  MAX_CHANGE_PAGES,
  LINE_STATS_CACHE_SIZE,
  chunk,
  detailablePaths,
  isApiError,
  User,
  Versioned,
  Listed,
  encodeIds,
  BranchCommit,
  SourceBlob,
  MAX_DIFF_FILE_BYTES,
  GitCafeDiffSourceUnavailableError,
  Changes,
  DiffFiles,
  encodeDiffCursor,
  decodeDiffCursor,
  MergeOutcome,
  StackOutcome,
  FAILED_STACK_STATES,
  type PullRef,
  type Paged,
  stackHeadsCurrent,
} from "./GitCafeProviderModel.ts";

/** HTTP transport and read helpers for the GitCafe pull-request provider. */
export const makeGitCafeProviderClient = Effect.gen(function* () {
  const api = yield* GitCafeApi.GitCafeApi;
  // GitCafe filters by actor id and has no lookup from a GitHub login to the actor sync made for
  // it, so the pairs are learned from the pull requests every listing reads.
  const knownAuthors = new Map<string, string>();
  const authorKey = (host: string, login: string) =>
    `${host.toLowerCase()}\n${login.toLowerCase()}`;
  const learnAuthors = (host: string, pulls: ReadonlyArray<Json.GitCafePull>) => {
    for (const { author } of pulls) {
      if (author.kind !== "github") continue;
      if (knownAuthors.size >= KNOWN_AUTHORS_LIMIT) knownAuthors.clear();
      knownAuthors.set(authorKey(host, author.login), author.actorId);
    }
  };

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("gitcafe"),
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const repositoryPath = (
    operation: string,
    input: ProviderRepositoryRef,
  ): Effect.Effect<string, PullRequestProviderError> =>
    GitCafeHosts.isGitCafeHost(input.host) &&
    GitCafeHosts.gitCafeRepositoryPath(input.repository) === input.repository
      ? Effect.succeed(`/repos/${input.repository}`)
      : Effect.fail(
          failure(
            operation,
            `GitCafe serves owner/name repositories on ${GitCafeHosts.GITCAFE_HOSTS.join(" and ")}.`,
          ),
        );

  const send = (
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    request: Omit<GitCafeApi.GitCafeApiRequest, "operation" | "host">,
  ) =>
    api.request({ ...request, host: input.host, operation }).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: SourceControlProviderKind.make("gitcafe"),
            operation,
            reason: error.reason,
            detail: error.detail,
            cause: error,
          }),
      ),
    );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    request: Omit<GitCafeApi.GitCafeApiRequest, "operation" | "host">,
    schema: S,
  ) =>
    send(operation, input, request).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            failure(operation, "GitCafe returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const pullPath = (operation: string, input: PullRef) =>
    repositoryPath(operation, input).pipe(Effect.map((base) => `${base}/pulls/${input.number}`));

  const readPull = (operation: string, input: PullRef) =>
    pullPath(operation, input).pipe(
      Effect.flatMap((path) => read(operation, input, { path }, Json.GitCafePullDetail)),
    );

  const readDiffSource = Effect.fn("GitCafePullRequestProvider.readDiffSource")(function* (
    input: ProviderRepositoryRef,
    revision: string,
    filePath: string,
  ) {
    const operation = "getDiffFileContents";
    const base = yield* repositoryPath(operation, input);
    const query = new URLSearchParams({ oid: revision, path: filePath });
    const blob = yield* read(operation, input, { path: `${base}/blob?${query}` }, SourceBlob).pipe(
      Effect.catchIf(
        (error) =>
          isApiError(error.cause) && (error.cause.status === 413 || error.cause.status === 501),
        (error) =>
          Effect.fail(
            failure(
              operation,
              "GitCafe cannot provide this source file as bounded text.",
              new GitCafeDiffSourceUnavailableError({
                path: filePath,
                reason:
                  isApiError(error.cause) && error.cause.status === 413
                    ? "oversized"
                    : "unavailable",
                cause: error,
              }),
            ),
          ),
      ),
    );
    if (blob.commit !== revision || blob.path !== filePath)
      return yield* failure(
        operation,
        "GitCafe answered with a different source revision or path.",
      );
    const reason =
      blob.size > MAX_DIFF_FILE_BYTES ||
      (blob.content !== null && Buffer.byteLength(blob.content, "utf8") > MAX_DIFF_FILE_BYTES)
        ? "oversized"
        : blob.binary || blob.content?.includes("\0")
          ? "binary"
          : blob.content === null
            ? "unavailable"
            : null;
    if (reason !== null)
      return yield* failure(
        operation,
        "GitCafe cannot provide this source file as bounded text.",
        new GitCafeDiffSourceUnavailableError({ path: filePath, reason }),
      );
    return blob.content!;
  });

  const readPages = Effect.fn("GitCafePullRequestProvider.readPages")(function* <
    S extends Schema.Codec<Paged<unknown>, unknown, never, never>,
  >(operation: string, input: Pick<ProviderRepositoryRef, "host">, path: string, schema: S) {
    const items: Array<S["Type"]["items"][number]> = [];
    let next: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (next !== null) query.set("after", next);
      const batch: S["Type"] = yield* read(operation, input, { path: `${path}?${query}` }, schema);
      items.push(...batch.items);
      const previous: string | null = next;
      next = batch.next;
      if (next === null || next === previous || batch.items.length === 0) break;
    }
    return { items, next };
  });

  /**
   * GitCafe filters by ids, so label names and the author's handle are looked up first. A label it
   * cannot resolve is left out, and the service narrows the rows by name instead. An author it
   * cannot resolve comes back as `unresolvedAuthor` for the listing to find.
   */
  const listFilterParams = Effect.fn("GitCafePullRequestProvider.listFilterParams")(function* (
    input: ProviderRepositoryRef & {
      readonly filters?: PullRequestListFilters | undefined;
      readonly authorNarrowed: boolean;
      readonly viewer: string;
    },
    base: string,
  ) {
    const filters = input.filters;
    const params: Array<readonly [string, string]> = [];
    if (filters === undefined) return { params, unresolvedAuthor: null };
    if (filters.draft !== undefined)
      params.push([filters.draft === "only" ? "states" : "stateNots", encodeIds(["draft"])]);
    const groups = filters.labels ?? [];
    const excluded = filters.excludedLabels ?? [];
    if (groups.length > 0 || excluded.length > 0) {
      const labels = yield* readPages(
        "listChangeRequests",
        input,
        `${base}/labels`,
        Json.GitCafeLabels,
      );
      const ids = new Map(labels.items.map((label) => [label.name.toLowerCase(), label.id]));
      const idsOf = (names: ReadonlyArray<string>) =>
        names.flatMap((name) => {
          const id = ids.get(name.trim().toLowerCase());
          return id === undefined ? [] : [id];
        });
      // Several ids in `labels` match a pull request holding any one of them, which is exactly
      // one group; the remaining groups are the service's to narrow.
      const group = groups.find((names) => idsOf(names).length === names.length);
      if (group !== undefined) params.push(["labels", encodeIds(idsOf(group))]);
      const excludedIds = idsOf(excluded);
      if (excludedIds.length > 0) params.push(["labelNots", encodeIds(excludedIds)]);
    }
    if (filters.author !== undefined && !input.authorNarrowed) {
      const handle = resolvePullRequestAuthorFilter(filters.author, input.viewer);
      // A profile matches what GitHub sync authored for it too. A GitHub-synced author with no
      // profile is known only by the actor on their pull requests.
      const user = yield* read(
        "listChangeRequests",
        input,
        { path: `/users/${encodeURIComponent(handle)}` },
        User,
      ).pipe(
        Effect.asSome,
        Effect.catchTags({
          PullRequestProviderError: (error) =>
            error.reason === "unauthenticated" || error.reason === "rate-limited"
              ? Effect.fail(error)
              : Effect.succeedNone,
        }),
      );
      const actorId = Option.isSome(user)
        ? user.value.actorId
        : knownAuthors.get(authorKey(input.host, handle));
      if (actorId === undefined) return { params, unresolvedAuthor: handle };
      params.push(["authors", encodeIds([actorId])]);
    }
    return { params, unresolvedAuthor: null };
  });

  const readComments = (operation: string, input: PullRef) =>
    pullPath(operation, input).pipe(
      Effect.flatMap((path) =>
        readPages(operation, input, `${path}/comments`, Json.GitCafeComments),
      ),
    );

  const isForbidden = (error: PullRequestProviderError) =>
    isApiError(error.cause) && error.cause.status === 403;

  /**
   * GitCafe offers no way to read a token's scopes, so reviewer controls show
   * for anyone who may edit the pull request; a token without the reviewer
   * scopes learns which ones it lacks when it uses them.
   */
  const explainReviewerScopes =
    (operation: string) =>
    <A, R>(effect: Effect.Effect<A, PullRequestProviderError, R>) =>
      effect.pipe(
        Effect.catchIf(isForbidden, (error) =>
          Effect.fail(
            failure(
              operation,
              "This GitCafe token cannot request reviewers. It needs the pr:review:read and pr:reviewers:write scopes.",
              error,
            ),
          ),
        ),
      );

  /**
   * GitCafe replaces a pull request's whole reviewer or label list, so one toggle reads the
   * list, changes it, and writes it back fenced on the pull request's version. The version is
   * read first: a change landing between the two reads then fails the fence instead of being
   * overwritten.
   */
  const toggleListed = Effect.fn("GitCafePullRequestProvider.toggleListed")(function* (
    operation: string,
    input: PullRef,
    list: { readonly name: "reviewers" | "labels"; readonly key: "actorIds" | "labelIds" },
    ids: ReadonlyArray<string>,
    on: boolean,
  ) {
    const path = yield* pullPath(operation, input);
    const pull = yield* readPull(operation, input);
    const listed = yield* readPages(operation, input, `${path}/${list.name}`, Listed);
    const current = listed.items.map((item) => item.id);
    const next = on
      ? [...new Set([...current, ...ids])]
      : current.filter((id) => !ids.includes(id));
    if (next.length === current.length) return;
    yield* read(
      operation,
      input,
      {
        method: "PUT",
        path: `${path}/${list.name}`,
        body: { expectedVersion: pull.version, [list.key]: next },
      },
      Versioned,
    );
  });

  /**
   * GitCafe's stack lists no heads, and they are what a land or restack is fenced on, so each
   * open layer's pull is read.
   */
  const readStack = Effect.fn("GitCafePullRequestProvider.readStack")(function* (
    operation: string,
    input: PullRef,
  ) {
    const path = yield* pullPath(operation, input);
    const { stack } = yield* read(
      operation,
      input,
      { path: `${path}/stack` },
      Json.GitCafeStackEnvelope,
    );
    if (stack === null) return null;
    const members = yield* Effect.forEach(
      stack.members,
      (member) =>
        member.state === "merged"
          ? Effect.succeed(member)
          : readPull(operation, { ...input, number: member.pullRequestNumber }).pipe(
              Effect.map((pull) =>
                pull.headOid == null ? member : { ...member, headOid: pull.headOid },
              ),
            ),
      { concurrency: 4 },
    );
    return { ...stack, members };
  });

  const readDiffPage = Effect.fn("GitCafePullRequestProvider.readDiffPage")(function* (
    operation: string,
    input: Parameters<PullRequestProviderApi["getDiff"]>[0],
    limit: number,
  ) {
    if (input.commit !== undefined)
      return yield* failure(operation, "GitCafe commit diffs are not supported yet.");
    const cursor =
      input.cursor === undefined
        ? null
        : yield* decodeDiffCursor(input.cursor).pipe(
            Effect.mapError((cause) => failure(operation, "Invalid GitCafe diff cursor.", cause)),
          );
    // A pull without a head yet has nothing to pin; its version still is.
    const expected = cursor ?? (yield* readPull(operation, input));
    const version = expected.version;
    const path = yield* pullPath(operation, input);
    const query = new URLSearchParams({ expectedVersion: String(version), limit: String(limit) });
    if (cursor !== null) query.set("after", cursor.after);
    const page = yield* read(operation, input, { path: `${path}/changes?${query}` }, Changes);
    if (
      page.version !== version ||
      (expected.headOid !== null && page.headOid !== expected.headOid) ||
      (cursor !== null && cursor.baseOid !== page.comparisonBaseOid)
    )
      return yield* failure(
        operation,
        "GitCafe answered from a different revision of the pull request. Refresh the diff.",
      );
    if (cursor !== null && page.next !== null && page.next === cursor.after)
      return yield* failure(operation, "GitCafe returned a repeated diff page cursor.");
    const revision = { version, headOid: page.headOid, baseOid: page.comparisonBaseOid };
    return {
      items: page.items,
      revision,
      nextCursor: page.next === null ? null : encodeDiffCursor({ ...revision, after: page.next }),
    };
  });

  const readDiffFiles = Effect.fn("GitCafePullRequestProvider.readDiffFiles")(function* (
    input: PullRef,
    revision: { readonly version: number; readonly headOid: string; readonly baseOid: string },
    paths: ReadonlyArray<string>,
  ) {
    if (paths.length === 0) return [];
    const path = yield* pullPath("getDiff", input);
    const files = yield* read(
      "getDiff",
      input,
      {
        method: "POST",
        path: `${path}/diff-files`,
        body: { paths, expectedVersion: revision.version },
      },
      DiffFiles,
    );
    if (
      files.version !== revision.version ||
      files.headOid !== revision.headOid ||
      files.comparisonBaseOid !== revision.baseOid
    )
      return yield* failure(
        "getDiff",
        "GitCafe answered from a different revision of the pull request. Refresh the diff.",
      );
    return files.items;
  });

  const runStackAction = Effect.fn("GitCafePullRequestProvider.runStackAction")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0] & { readonly stackNumber: number },
  ) {
    const land = input.action === "merge";
    const operation = land ? "landStackThrough" : "restackStack";
    if (!land && input.action !== "update-branch")
      return yield* failure(operation, `GitCafe cannot ${input.action} a stack.`);
    const stack = yield* readStack(operation, input);
    if (
      stack === null ||
      stack.number !== input.stackNumber ||
      input.expectedStackHeads === undefined ||
      !stackHeadsCurrent(stack, { number: input.number, merge: land }, input.expectedStackHeads)
    )
      return yield* failure(
        operation,
        "The stack changed since it was read. Refresh it and try again.",
      );
    const base = yield* repositoryPath(operation, input);
    const outcome = yield* read(
      operation,
      input,
      {
        method: "POST",
        path: `${base}/pulls/stacks/${stack.number}/${land ? "land-through" : "restack"}`,
        body: land
          ? {
              expectedRevision: stack.revision,
              requestId: yield* randomUuidV4,
              throughPullRequestNumber: input.number,
              strategy: input.mergeMethod ?? "merge",
            }
          : { expectedRevision: stack.revision, requestId: yield* randomUuidV4 },
      },
      StackOutcome,
    );
    if (FAILED_STACK_STATES.has(outcome.state))
      return yield* failure(operation, `GitCafe's stack operation ${outcome.state}.`);
  });

  // GitCafe's pulls carry no line totals, and linked pull requests are summarized every minute,
  // so hunk totals are held per compared pair of commits. The file list that names the pair is
  // cheap; a retarget or a landed parent layer moves the base without moving the head.
  const lineTotals = new Map<string, { readonly additions: number; readonly deletions: number }>();
  // The compared pair follows from the head and the target tip the pull reports, so while neither
  // moves the stats are reused without listing the files again.
  const statsByTips = new Map<
    string,
    { readonly changedFiles: number; readonly additions?: number; readonly deletions?: number }
  >();
  const remember = <K, V>(cache: Map<K, V>, key: K, value: V) => {
    if (cache.size >= LINE_STATS_CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
  };

  // readLineStats owns the span.
  const countLines = Effect.fnUntraced(function* (input: PullRef, version: number) {
    const path = yield* pullPath("getChangeRequest", input);
    const files: Array<Json.GitCafeDiffFile> = [];
    let revision: { version: number; headOid: string; baseOid: string } | undefined;
    let after: string | null = null;
    for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
      const query = new URLSearchParams({
        expectedVersion: String(version),
        limit: String(CHANGES_PAGE_LIMIT),
      });
      if (after !== null) query.set("after", after);
      const batch: typeof Changes.Type = yield* read(
        "getChangeRequest",
        input,
        { path: `${path}/changes?${query}` },
        Changes,
      );
      revision ??= {
        version: batch.version,
        headOid: batch.headOid,
        baseOid: batch.comparisonBaseOid,
      };
      files.push(...batch.items);
      const previous: string | null = after;
      after = batch.next;
      if (after === null || after === previous || batch.items.length === 0) break;
    }
    if (revision === undefined)
      return {
        headOid: null,
        complete: true,
        stats: { changedFiles: 0, additions: 0, deletions: 0 },
      };
    const key = `${input.host} ${input.repository.toLowerCase()} ${input.number} ${revision.baseOid} ${revision.headOid}`;
    const held = lineTotals.get(key);
    const { headOid } = revision;
    // A listing that stopped before its last page counts only part of the diff, so nothing is held.
    const listed = after === null;
    if (held !== undefined)
      return { headOid, complete: listed, stats: { changedFiles: files.length, ...held } };
    const tooMany = files.length > LINE_STATS_MAX_FILES;
    const details = files.some((file) => file.additions !== undefined)
      ? Option.some(files)
      : tooMany
        ? Option.none()
        : yield* Effect.forEach(
            chunk(detailablePaths(files), DIFF_FILES_BATCH),
            (paths) => readDiffFiles(input, revision, paths),
            { concurrency: 4 },
          ).pipe(
            Effect.map((batches) => batches.flat()),
            Effect.option,
          );
    // Unread hunks leave the lines unknown rather than zero; the file count still stands.
    if (Option.isNone(details))
      return { headOid, complete: listed && tooMany, stats: { changedFiles: files.length } };
    const counted = details.value;
    const totals = {
      additions: counted.reduce((total, file) => total + (file.additions ?? 0), 0),
      deletions: counted.reduce((total, file) => total + (file.deletions ?? 0), 0),
    };
    if (listed) remember(lineTotals, key, totals);
    return { headOid, complete: listed, stats: { changedFiles: files.length, ...totals } };
  });

  const readLineStats = Effect.fn("GitCafePullRequestProvider.readLineStats")(function* (
    input: PullRef,
    pull: Json.GitCafePullDetail,
  ) {
    const tipsKey =
      pull.headOid === null || pull.observedBaseOid == null
        ? null
        : `${input.host} ${input.repository.toLowerCase()} ${input.number} ${pull.targetBranch} ${pull.observedBaseOid} ${pull.headOid}`;
    const heldStats = tipsKey === null ? undefined : statsByTips.get(tipsKey);
    if (heldStats !== undefined) return heldStats;
    const stats = yield* countLines(input, pull.version);
    // A failed hunk read is retried next time rather than held as unknown, and a head that moved
    // between the two reads would hold another pair's stats.
    if (tipsKey !== null && stats.complete && stats.headOid === pull.headOid)
      remember(statsByTips, tipsKey, stats.stats);
    return stats.stats;
  });

  const merge = Effect.fn("GitCafePullRequestProvider.merge")(function* (
    input: Parameters<PullRequestProviderApi["runAction"]>[0],
  ) {
    const pull = yield* readPull("merge", input);
    if (pull.state === "merged") return;
    if (pull.mergeRoute === "unsupported")
      return yield* failure("merge", "This GitCafe pull request has no supported merge route.");
    const base = yield* repositoryPath("merge", input);
    // Native merges fence on the current target commit; provider-routed merges supply the base.
    const baseOid =
      pull.mergeRoute === "provider"
        ? pull.observedBaseOid
        : (yield* read(
            "merge",
            input,
            {
              path: `${base}/commit?ref=${encodeURIComponent(`refs/heads/${pull.targetBranch}`)}`,
            },
            BranchCommit,
          )).oid;
    if (pull.headOid === null || baseOid == null)
      return yield* failure(
        "merge",
        "GitCafe has not reported the pull request's head and base yet. Refresh and try again.",
      );
    const path = yield* pullPath("merge", input);
    const outcome = yield* read(
      "merge",
      input,
      {
        method: "POST",
        path: `${path}/merge`,
        body: {
          requestId: yield* randomUuidV4,
          expectedVersion: pull.version,
          headOid: pull.headOid,
          baseOid,
          strategy: input.mergeMethod ?? "merge",
        },
      },
      MergeOutcome,
    );
    if (outcome.state === "failed")
      return yield* failure("merge", outcome.reason ?? "GitCafe could not merge the pull request.");
  });

  return {
    api,
    knownAuthors,
    authorKey,
    learnAuthors,
    failure,
    repositoryPath,
    send,
    read,
    pullPath,
    readPull,
    readDiffSource,
    readPages,
    listFilterParams,
    readComments,
    isForbidden,
    explainReviewerScopes,
    toggleListed,
    readStack,
    readDiffPage,
    readDiffFiles,
    runStackAction,
    lineTotals,
    statsByTips,
    remember,
    countLines,
    readLineStats,
    merge,
  };
});
