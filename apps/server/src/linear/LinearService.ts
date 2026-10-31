import {
  LinearError,
  type LinearActivityResult,
  type LinearConnectInput,
  type LinearConnectionStatus,
  type LinearCustomView,
  type LinearIssue,
  type LinearIssueDetail,
  LinearIssueFilter,
  type LinearIssueListResult,
  type LinearMilestone,
  type LinearOrganization,
  type LinearProject,
  type LinearRecordLaunchInput,
  type LinearRecordLaunchResult,
  type LinearTeam,
  type LinearTeamMetadata,
  type LinearViewer,
  type PipelineRunId,
} from "@t3tools/contracts";
import {
  type IssueTrackerError,
  toLinearError,
  Unauthorized,
} from "@t3tools/issue-tracker-core/errors";
import type { IssueTracker } from "@t3tools/issue-tracker-core/IssueTracker";
import { apiKeyAuth } from "@t3tools/issue-tracker-core/IssueTrackerAuth";
import { makeLinearTracker, normalizeIssueFilter } from "@t3tools/issue-tracker-linear/client";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  isStateMoveEligible,
  renderChatCommentBody,
  renderPipelineCommentBody,
} from "@t3tools/shared/linearWriteBack";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PipelineService from "../pipelines/PipelineService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { computeLinearActivity } from "./LinearActivity.ts";
import { type LinearBackoff, makeLinearBackoff } from "./LinearBackoff.ts";
import { type LinearCache, makeLinearCache } from "./LinearCache.ts";
import * as LinearLinkStore from "./LinearLinkStore.ts";

const MINUTE_MS = 60_000;
/** Reference data changes rarely and is read on every navigation. */
const REFERENCE_TTL_MS = 5 * MINUTE_MS;
const MILESTONE_TTL_MS = 2 * MINUTE_MS;
const ISSUE_TTL_MS = MINUTE_MS;
const SEARCH_TTL_MS = 30_000;
const CACHE_CAPACITY = 200;
/** Issue lists hold up to 250 issues each, so far fewer of them are kept. */
const LIST_CACHE_CAPACITY = 30;
/** Pipeline comments are only kept current for recent runs. */
const PIPELINE_COMMENT_WINDOW_MS = 14 * 24 * 60 * MINUTE_MS;

const issueFilterKey = Schema.encodeSync(Schema.fromJsonString(LinearIssueFilter));

const unavailableStorage = () =>
  new LinearError({ reason: "unavailable", message: "Could not read Linear link storage." });

type Call<A> = Effect.Effect<A, LinearError>;

export class LinearService extends Context.Service<
  LinearService,
  {
    readonly status: Call<LinearConnectionStatus>;
    readonly connect: (input: LinearConnectInput) => Call<LinearConnectionStatus>;
    readonly disconnect: Call<LinearConnectionStatus>;
    /** Drops every cache and backoff, then refetches the connection. */
    readonly resync: Call<void>;
    /** Drops issue-level caches so the next read is fresh, and tells subscribers to refetch. */
    readonly refresh: Call<void>;
    readonly teams: Call<ReadonlyArray<LinearTeam>>;
    readonly teamMetadata: (teamId: string) => Call<LinearTeamMetadata>;
    readonly projects: (teamId: string | undefined) => Call<ReadonlyArray<LinearProject>>;
    readonly milestones: (projectId: string) => Call<ReadonlyArray<LinearMilestone>>;
    readonly issues: (filter: LinearIssueFilter) => Call<LinearIssueListResult>;
    readonly issueDetail: (issueId: string) => Call<LinearIssueDetail>;
    readonly subIssues: (issueId: string) => Call<ReadonlyArray<LinearIssue>>;
    readonly views: Call<ReadonlyArray<LinearCustomView>>;
    readonly search: (term: string) => Call<ReadonlyArray<LinearIssue>>;
    readonly activity: Call<LinearActivityResult>;
    readonly recordLaunch: (input: LinearRecordLaunchInput) => Call<LinearRecordLaunchResult>;
    /** Emits an incrementing revision whenever clients should refetch. */
    readonly subscribeRefreshes: Stream.Stream<number>;
    /** Brings a pipeline link's issue comment in line with its run (posting it if none exists yet). */
    readonly syncPipelineComment: (
      stored: LinearLinkStore.StoredLink,
    ) => Effect.Effect<void, LinearError>;
  }
>()("t3/linear/LinearService") {}

interface ViewerInfo {
  readonly viewer: LinearViewer;
  readonly organization: LinearOrganization;
}

export const layer = Layer.effect(
  LinearService,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const http = yield* HttpClient.HttpClient;
    const store = yield* LinearLinkStore.LinearLinkStore;
    const pipelines = yield* PipelineService.PipelineService;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const crypto = yield* Crypto.Crypto;
    const linkLock = yield* KeyedLock.make<string>();

    const backoff: LinearBackoff = makeLinearBackoff();
    const refreshes = yield* SubscriptionRef.make(0);
    const bumpRefresh = SubscriptionRef.update(refreshes, (revision) => revision + 1);

    const readApiKey = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.linear.apiKey),
      // A settings read failure must not look like a key problem; callers see "not connected"
      // only for a genuinely empty key, so fall back to the empty key and log.
      Effect.catch((error) =>
        Effect.logWarning("Could not read Linear settings", { cause: error }).pipe(Effect.as("")),
      ),
    );

    const tracker: IssueTracker = yield* makeLinearTracker({
      auth: apiKeyAuth(readApiKey),
      observeRateLimit: backoff.noteRateLimit,
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));

    const viewerCache = makeLinearCache<ViewerInfo>(2);
    const teamsCache = makeLinearCache<ReadonlyArray<LinearTeam>>(2);
    const teamMetadataCache = makeLinearCache<LinearTeamMetadata>(CACHE_CAPACITY);
    const projectsCache = makeLinearCache<ReadonlyArray<LinearProject>>(CACHE_CAPACITY);
    const viewsCache = makeLinearCache<ReadonlyArray<LinearCustomView>>(2);
    const milestonesCache = makeLinearCache<ReadonlyArray<LinearMilestone>>(CACHE_CAPACITY);
    const issueListCache = makeLinearCache<{
      readonly issues: ReadonlyArray<LinearIssue>;
      readonly truncated: boolean;
    }>(LIST_CACHE_CAPACITY);
    const issueDetailCache = makeLinearCache<LinearIssueDetail>(CACHE_CAPACITY);
    const issueCache = makeLinearCache<LinearIssue>(CACHE_CAPACITY);
    const subIssuesCache = makeLinearCache<ReadonlyArray<LinearIssue>>(LIST_CACHE_CAPACITY);
    const searchCache = makeLinearCache<ReadonlyArray<LinearIssue>>(LIST_CACHE_CAPACITY);

    const expireIssueCaches = Effect.all(
      [
        issueListCache.expire,
        issueDetailCache.expire,
        issueCache.expire,
        subIssuesCache.expire,
        searchCache.expire,
        milestonesCache.expire,
        // Team cards carry per-viewer issue counts, so they go stale with the issues.
        teamsCache.expire,
      ],
      { discard: true },
    );
    const clearAllCaches = Effect.all(
      [
        issueListCache.clear,
        issueDetailCache.clear,
        issueCache.clear,
        subIssuesCache.clear,
        searchCache.clear,
        milestonesCache.clear,
        viewerCache.clear,
        teamsCache.clear,
        teamMetadataCache.clear,
        projectsCache.clear,
        viewsCache.clear,
      ],
      { discard: true },
    );

    // Caches belong to one key: pasting a different key through plain settings must not show the
    // old workspace's data, so any key change drops everything before the next read.
    let cachedForKey: string | null = null;
    const scopeToCurrentKey = Effect.gen(function* () {
      const key = yield* readApiKey;
      if (cachedForKey === key) return key;
      cachedForKey = key;
      yield* clearAllCaches;
      if ((yield* backoff.rejectedKey) !== key) yield* backoff.reset;
      return key;
    });

    /** Cached read behind the backoff guard; failures become wire errors. */
    const cached = Effect.fn("LinearService.cached")(function* <V>(
      cache: LinearCache<V>,
      key: string,
      ttlMs: number,
      load: Effect.Effect<V, IssueTrackerError>,
    ) {
      const apiKey = yield* scopeToCurrentKey;
      // A rejected key must surface even while a still-fresh entry could answer.
      if (apiKey.length > 0 && (yield* backoff.rejectedKey) === apiKey) {
        return yield* new Unauthorized();
      }
      return yield* cache.get(key, ttlMs, backoff.guard(apiKey, load));
    }, Effect.mapError(toLinearError));

    const cachedValue = <V>(
      cache: LinearCache<V>,
      key: string,
      ttlMs: number,
      load: Effect.Effect<V, IssueTrackerError>,
    ) => cached(cache, key, ttlMs, load).pipe(Effect.map((hit) => hit.value));

    const viewerInfo = cachedValue(viewerCache, "viewer", REFERENCE_TTL_MS, tracker.verify);
    const teams = cachedValue(teamsCache, "teams", REFERENCE_TTL_MS, tracker.teams);

    const emptyStatus = (state: "disconnected" | "invalid"): LinearConnectionStatus => ({
      state,
      method: state === "disconnected" ? null : "api-key",
      organization: null,
      viewer: null,
      teams: [],
      rateLimitedUntil: null,
    });

    const rateLimitedUntilIso = Effect.gen(function* () {
      const until = yield* backoff.rateLimitedUntilMs;
      return until === null ? null : DateTime.formatIso(DateTime.makeUnsafe(until));
    });

    const status: Call<LinearConnectionStatus> = Effect.gen(function* () {
      const key = yield* scopeToCurrentKey;
      if (key.length === 0) return emptyStatus("disconnected");
      const loaded = yield* Effect.all([viewerInfo, teams], { concurrency: 2 }).pipe(
        Effect.catchIf(
          (error) => error.reason === "unauthorized",
          () => Effect.succeed(null),
        ),
      );
      if (loaded === null) return emptyStatus("invalid");
      const [info, visibleTeams] = loaded;
      return {
        state: "connected",
        method: "api-key",
        organization: info.organization,
        viewer: info.viewer,
        teams: visibleTeams,
        rateLimitedUntil: yield* rateLimitedUntilIso,
      } satisfies LinearConnectionStatus;
    });

    const updateApiKey = (apiKey: string) =>
      serverSettings
        .updateSettings({ linear: { apiKey } })
        .pipe(
          Effect.mapError(
            () =>
              new LinearError({ reason: "unavailable", message: "Could not save the API key." }),
          ),
        );

    const connect: LinearService["Service"]["connect"] = Effect.fn("LinearService.connect")(
      function* (input) {
        // Verify with the candidate key before anything is stored; a bad key leaves no trace.
        const verifier = yield* makeLinearTracker({
          auth: apiKeyAuth(Effect.succeed(input.apiKey)),
        }).pipe(Effect.provideService(HttpClient.HttpClient, http));
        const info = yield* verifier.verify.pipe(
          Effect.mapError((error): LinearError => {
            if (error._tag === "IssueTrackerUnauthorized") {
              return new LinearError({
                reason: "unauthorized",
                message: "Linear rejected this key.",
              });
            }
            if (error._tag === "IssueTrackerRateLimited" || error._tag === "IssueTrackerRejected") {
              return toLinearError(error);
            }
            return new LinearError({ reason: "unavailable", message: "Couldn't reach Linear." });
          }),
        );
        yield* updateApiKey(input.apiKey);
        yield* clearAllCaches;
        yield* backoff.reset;
        cachedForKey = input.apiKey;
        yield* viewerCache
          .get("viewer", REFERENCE_TTL_MS, Effect.succeed(info))
          .pipe(Effect.ignore);
        yield* bumpRefresh;
        return yield* status;
      },
    );

    const disconnect: Call<LinearConnectionStatus> = Effect.gen(function* () {
      // Links and mappings stay: reconnecting restores the T3 activity view.
      yield* updateApiKey("");
      yield* clearAllCaches;
      yield* backoff.reset;
      cachedForKey = "";
      yield* bumpRefresh;
      return emptyStatus("disconnected");
    });

    const resync: Call<void> = Effect.gen(function* () {
      yield* scopeToCurrentKey;
      yield* clearAllCaches;
      yield* backoff.reset;
      yield* Effect.ignore(status);
      yield* bumpRefresh;
    });

    const refresh: Call<void> = Effect.gen(function* () {
      yield* scopeToCurrentKey;
      yield* expireIssueCaches;
      yield* backoff.clearOutage;
      yield* bumpRefresh;
    });

    const issues: LinearService["Service"]["issues"] = Effect.fn("LinearService.issues")(
      function* (filter) {
        const normalized = normalizeIssueFilter(filter);
        const hit = yield* cached(
          issueListCache,
          issueFilterKey(normalized),
          ISSUE_TTL_MS,
          tracker.issues(normalized),
        );
        return {
          issues: hit.value.issues,
          truncated: hit.value.truncated,
          fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(hit.fetchedAtMs)),
          stale: hit.stale,
        };
      },
    );

    // ── Launch write-backs ────────────────────────────────────────────────

    const writeBackFailure = (error: LinearError) => error.message;

    const trackerCall = Effect.fn("LinearService.trackerCall")(function* <A>(
      effect: Effect.Effect<A, IssueTrackerError>,
    ) {
      const apiKey = yield* scopeToCurrentKey;
      return yield* backoff.guard(apiKey, effect);
    }, Effect.mapError(toLinearError));

    const bodyHash = (body: string) => String(Hash.string(body));

    /** Posts or edits the one comment of a pipeline link. Serialized per link, so never duplicated. */
    const syncPipelineComment: LinearService["Service"]["syncPipelineComment"] = (stored) =>
      linkLock.withLock(
        stored.link.linkId,
        Effect.gen(function* () {
          const run = yield* pipelines
            .getRun(stored.link.targetId as PipelineRunId)
            .pipe(
              Effect.mapError(
                () => new LinearError({ reason: "not_found", message: "Pipeline run not found." }),
              ),
            );
          const body = renderPipelineCommentBody({
            pipelineName: run.definition.name,
            threadUrl: stored.threadUrl,
            runStatus: run.status,
            steps: run.steps.map((step) => ({
              name:
                run.definition.steps.find((candidate) => candidate.id === step.stepId)?.name ??
                step.stepId,
              status: step.status,
            })),
          });
          // Re-read inside the lock: another caller may have posted since `stored` was loaded.
          const current = yield* store
            .get(stored.link.linkId)
            .pipe(Effect.mapError(unavailableStorage));
          if (current === null) return;
          const hash = bodyHash(body);
          if (current.link.commentId === null) {
            const created = yield* trackerCall(tracker.createComment(stored.link.issueId, body));
            yield* store
              .recordComment(stored.link.linkId, created.id, hash)
              .pipe(Effect.mapError(unavailableStorage));
          } else if (current.commentBodyHash !== hash) {
            yield* trackerCall(tracker.updateComment(current.link.commentId, body));
            yield* store
              .recordBodyHash(stored.link.linkId, hash)
              .pipe(Effect.mapError(unavailableStorage));
          }
        }),
      );

    const recordLaunch: LinearService["Service"]["recordLaunch"] = Effect.fn(
      "LinearService.recordLaunch",
    )(function* (input) {
      // Linear unreachable: link from what the client knew and skip the immediate write-backs.
      const unreadable: { error: LinearError | null } = { error: null };
      const loaded = yield* cached(
        issueCache,
        input.issueId,
        ISSUE_TTL_MS,
        tracker.issue(input.issueId),
      ).pipe(
        Effect.map((entry) => Option.some(entry.value)),
        Effect.catchIf(
          (error) => input.issue !== undefined && error.reason !== "not_found",
          (error) =>
            Effect.sync(() => {
              unreadable.error = error;
              return Option.none<LinearIssue>();
            }),
        ),
      );
      const issue = Option.getOrNull(loaded);
      const { target } = input;
      // A pipeline comment is the reactor's job, so it still lands once Linear is readable again.
      const commentMode = !input.writeBack.comment
        ? "none"
        : target.kind === "pipeline_run"
          ? "pipeline"
          : issue === null
            ? "none"
            : "thread";
      const identity =
        issue !== null
          ? {
              identifier: issue.identifier,
              teamId: issue.team.id,
              projectId: issue.project?.id ?? null,
            }
          : {
              identifier: input.issue!.identifier,
              teamId: input.issue!.teamId,
              projectId: input.issue!.projectId ?? null,
            };
      const stored = yield* store
        .upsert({
          linkId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
          issueId: input.issueId,
          issueIdentifier: identity.identifier,
          teamId: identity.teamId,
          projectId: identity.projectId,
          targetKind: target.kind,
          targetId: target.targetId,
          threadId: target.threadId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          commentMode,
          threadUrl: input.threadUrl,
        })
        .pipe(Effect.mapError(unavailableStorage));

      const warnings: Array<{ step: "move_state" | "comment"; message: string }> = [];
      // A missing or rejected key is a setup state; an outage or rate limit deserves a heads-up.
      if (
        unreadable.error !== null &&
        (unreadable.error.reason === "unavailable" || unreadable.error.reason === "rate_limited")
      ) {
        const message = writeBackFailure(unreadable.error);
        if (input.writeBack.moveToStateId !== undefined) {
          warnings.push({ step: "move_state", message });
        }
        if (commentMode === "none" && input.writeBack.comment) {
          warnings.push({ step: "comment", message });
        }
      }

      const recordWarning = (step: "move_state" | "comment") => (error: LinearError) =>
        Effect.logWarning(`Linear ${step} write-back failed`, { reason: error.reason }).pipe(
          Effect.andThen(
            Effect.sync(() => warnings.push({ step, message: writeBackFailure(error) })),
          ),
        );

      // Write-backs are best effort and run once per link, so repeating the call is harmless. The
      // link is re-read under its lock so concurrent launches cannot both move or comment.
      if (issue !== null) {
        const moveToStateId = input.writeBack.moveToStateId;
        yield* linkLock.withLock(
          stored.link.linkId,
          Effect.gen(function* () {
            const current =
              (yield* store.get(stored.link.linkId).pipe(Effect.mapError(unavailableStorage)))
                ?.link ?? stored.link;
            if (
              moveToStateId !== undefined &&
              current.stateMovedTo === null &&
              isStateMoveEligible(issue.state.type)
            ) {
              yield* trackerCall(tracker.moveIssueToState(issue.id, moveToStateId)).pipe(
                Effect.andThen(
                  store
                    .recordStateMove(stored.link.linkId, moveToStateId)
                    .pipe(Effect.mapError(unavailableStorage)),
                ),
                Effect.andThen(expireIssueCaches),
                Effect.catch(recordWarning("move_state")),
              );
            }
            if (
              input.writeBack.comment &&
              current.commentMode === "thread" &&
              current.commentId === null
            ) {
              yield* Effect.gen(function* () {
                const { viewer } = yield* viewerInfo;
                const body = renderChatCommentBody({
                  viewerName: viewer.name,
                  threadTitle: target.title,
                  threadUrl: input.threadUrl,
                });
                const created = yield* trackerCall(tracker.createComment(issue.id, body));
                yield* store
                  .recordComment(stored.link.linkId, created.id, bodyHash(body))
                  .pipe(Effect.mapError(unavailableStorage));
              }).pipe(Effect.catch(recordWarning("comment")));
            }
          }),
        );
        if (input.writeBack.comment && stored.link.commentMode === "pipeline") {
          yield* syncPipelineComment(stored).pipe(Effect.catch(recordWarning("comment")));
        }
      }

      const link =
        (yield* store.get(stored.link.linkId).pipe(Effect.mapError(unavailableStorage)))?.link ??
        stored.link;
      yield* bumpRefresh;
      return { link, warnings } satisfies LinearRecordLaunchResult;
    });

    return LinearService.of({
      status,
      connect,
      disconnect,
      resync,
      refresh,
      teams,
      teamMetadata: Effect.fn("LinearService.teamMetadata")(function* (teamId) {
        return yield* cachedValue(
          teamMetadataCache,
          teamId,
          REFERENCE_TTL_MS,
          tracker.teamMetadata(teamId),
        );
      }),
      projects: Effect.fn("LinearService.projects")(function* (teamId) {
        return yield* cachedValue(
          projectsCache,
          teamId ?? "*",
          REFERENCE_TTL_MS,
          tracker.projects(teamId),
        );
      }),
      milestones: Effect.fn("LinearService.milestones")(function* (projectId) {
        return yield* cachedValue(
          milestonesCache,
          projectId,
          MILESTONE_TTL_MS,
          tracker.milestones(projectId),
        );
      }),
      issues,
      issueDetail: Effect.fn("LinearService.issueDetail")(function* (issueId) {
        return yield* cachedValue(
          issueDetailCache,
          issueId,
          ISSUE_TTL_MS,
          tracker.issueDetail(issueId),
        );
      }),
      subIssues: Effect.fn("LinearService.subIssues")(function* (issueId) {
        return yield* cachedValue(
          subIssuesCache,
          issueId,
          ISSUE_TTL_MS,
          tracker.subIssues(issueId),
        );
      }),
      views: cachedValue(viewsCache, "views", REFERENCE_TTL_MS, tracker.views),
      search: Effect.fn("LinearService.search")(function* (term) {
        return yield* cachedValue(
          searchCache,
          term.toLowerCase(),
          SEARCH_TTL_MS,
          tracker.search(term),
        );
      }),
      activity: computeLinearActivity(store, pipelines, projection).pipe(
        Effect.mapError(unavailableStorage),
      ),
      recordLaunch,
      subscribeRefreshes: SubscriptionRef.changes(refreshes).pipe(
        Stream.filter((revision) => revision > 0),
      ),
      syncPipelineComment,
    });
  }),
);

/** Cutoff for pipeline links the comment reactor still maintains. */
export const pipelineCommentCutoff = Effect.map(Clock.currentTimeMillis, (nowMs) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - PIPELINE_COMMENT_WINDOW_MS)),
);
