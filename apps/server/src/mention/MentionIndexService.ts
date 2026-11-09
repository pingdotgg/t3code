import type {
  MentionIndexFigmaBrowseInput,
  MentionIndexFigmaBrowseTeamsResult,
  MentionIndexFigmaListProjectsInput,
  MentionIndexFigmaListProjectsResult,
  MentionIndexProviderId,
  MentionIndexSearchInput,
  MentionIndexSearchResult,
  MentionIndexThumbnailInput,
  MentionIndexThumbnailResult,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { MentionIndex, mentionIndexThumbKey } from "./MentionIndex.ts";
import { MentionIndexFigmaSyncer } from "./MentionIndexFigmaSyncer.ts";
import { MentionIndexIssueSyncer } from "./MentionIndexIssueSyncer.ts";
import { MentionIndexJiraSyncer } from "./MentionIndexJiraSyncer.ts";
import { MentionIndexPrSyncer } from "./MentionIndexPrSyncer.ts";
import { MentionIndexThreadSyncer } from "./MentionIndexThreadSyncer.ts";
import {
  parseExactFigmaQuery,
  parseExactIssueQuery,
  parseExactJiraQuery,
  parseExactPullRequestQuery,
} from "./mentionIndexExact.ts";

const MENTION_INDEX_DISABLED_DETAIL = "Mention index is off. Turn it on in Settings → Labs.";

export class MentionIndexService extends Context.Service<
  MentionIndexService,
  {
    readonly search: (input: MentionIndexSearchInput) => Effect.Effect<MentionIndexSearchResult>;
    readonly ensureIndexed: (input: {
      readonly projectId: ProjectId;
      readonly query?: string;
      readonly providers?: ReadonlyArray<MentionIndexProviderId>;
    }) => Effect.Effect<MentionIndexSearchResult>;
    readonly thumbnail: (
      input: MentionIndexThumbnailInput,
    ) => Effect.Effect<MentionIndexThumbnailResult>;
    readonly figmaListTeams: (
      input: MentionIndexFigmaBrowseInput,
    ) => Effect.Effect<MentionIndexFigmaBrowseTeamsResult>;
    readonly figmaListProjects: (
      input: MentionIndexFigmaListProjectsInput,
    ) => Effect.Effect<MentionIndexFigmaListProjectsResult>;
  }
>()("t3/mention/MentionIndexService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const index = yield* MentionIndex;
  const pullRequests = yield* MentionIndexPrSyncer;
  const threads = yield* MentionIndexThreadSyncer;
  const jira = yield* MentionIndexJiraSyncer;
  const issues = yield* MentionIndexIssueSyncer;
  const figma = yield* MentionIndexFigmaSyncer;

  const mentionIndexEnabled = settings.getSettings.pipe(
    Effect.map((value) => value.mentionIndexEnabled),
    Effect.orElseSucceed(() => false),
  );

  const disabledSearch = (): MentionIndexSearchResult => ({
    hits: [],
    status: "empty",
    detail: MENTION_INDEX_DISABLED_DETAIL,
  });

  const ensureProviders = Effect.fn("MentionIndexService.ensureProviders")(function* (
    projectId: ProjectId,
    providers: ReadonlyArray<MentionIndexProviderId>,
  ) {
    if (providers.includes("pull-request")) yield* pullRequests.ensureIndexed(projectId);
    if (providers.includes("thread")) yield* threads.ensureIndexed(projectId);
    if (providers.includes("jira")) yield* jira.ensureIndexed(projectId);
    if (providers.includes("issue")) yield* issues.ensureIndexed(projectId);
    if (providers.includes("figma")) yield* figma.ensureIndexed(projectId);
  });

  /**
   * When the query names one concrete item, always fetch it into the index.
   * Misses await write-through so the search result includes it; hits refresh in the background.
   */
  const ensureExactPresence = Effect.fn("MentionIndexService.ensureExactPresence")(function* (
    input: MentionIndexSearchInput,
    providers: ReadonlyArray<MentionIndexProviderId>,
  ) {
    const query = input.query.trim();
    if (query.length === 0) return;

    const local = yield* index.search({
      ...input,
      providers: [...providers],
      limit: Math.min(input.limit ?? 50, 50),
    });

    const tasks: Array<Effect.Effect<void>> = [];

    if (providers.includes("pull-request")) {
      const exact = parseExactPullRequestQuery(query);
      if (exact !== null) {
        const hasHit = local.hits.some(
          (hit) =>
            hit.pullRequest !== undefined &&
            hit.pullRequest.number === exact.number &&
            (exact.repository === undefined ||
              hit.pullRequest.repository.trim().toLowerCase() === exact.repository),
        );
        const fetch = pullRequests.ensureExact(input.projectId, exact);
        tasks.push(hasHit ? fetch.pipe(Effect.forkDetach, Effect.asVoid) : fetch);
      }
    }

    if (providers.includes("issue")) {
      const exact = parseExactIssueQuery(query);
      if (exact !== null) {
        const hasHit = local.hits.some(
          (hit) =>
            hit.issue !== undefined &&
            hit.issue.number === exact.number &&
            (exact.repository === undefined ||
              hit.issue.repository.trim().toLowerCase() === exact.repository),
        );
        const fetch = issues.ensureExact(input.projectId, exact);
        tasks.push(hasHit ? fetch.pipe(Effect.forkDetach, Effect.asVoid) : fetch);
      }
    }

    if (providers.includes("jira")) {
      const key = parseExactJiraQuery(query);
      if (key !== null) {
        const hasHit = local.hits.some(
          (hit) => hit.jira !== undefined && hit.jira.key.toUpperCase() === key.toUpperCase(),
        );
        const fetch = jira.ensureExact(input.projectId, key);
        tasks.push(hasHit ? fetch.pipe(Effect.forkDetach, Effect.asVoid) : fetch);
      }
    }

    if (providers.includes("figma")) {
      const fileKey = parseExactFigmaQuery(query);
      if (fileKey !== null) {
        const hasHit = local.hits.some(
          (hit) => hit.figma !== undefined && hit.figma.fileKey === fileKey,
        );
        const fetch = figma.ensureExact(input.projectId, fileKey);
        tasks.push(hasHit ? fetch.pipe(Effect.forkDetach, Effect.asVoid) : fetch);
      }
    }

    if (tasks.length === 0) return;
    yield* Effect.all(tasks, { concurrency: "unbounded" });
  });

  return MentionIndexService.of({
    search: Effect.fn("MentionIndexService.search")(function* (input) {
      if (!(yield* mentionIndexEnabled)) return disabledSearch();
      const providers = input.providers ?? (["pull-request"] as const);
      yield* ensureProviders(input.projectId, providers);
      yield* ensureExactPresence(input, providers);
      return yield* index.search(input);
    }),

    ensureIndexed: Effect.fn("MentionIndexService.ensureIndexed")(function* (input) {
      if (!(yield* mentionIndexEnabled)) return disabledSearch();
      const query = input.query?.trim() ?? "";
      if (query.length > 0) {
        const providers = input.providers ?? (["pull-request", "issue", "jira", "figma"] as const);
        yield* ensureProviders(input.projectId, providers);
        yield* ensureExactPresence(
          {
            projectId: input.projectId,
            query,
            providers: [...providers],
            limit: 1,
          },
          providers,
        );
        return yield* index.search({
          projectId: input.projectId,
          providers: [...providers],
          query,
          limit: 1,
        });
      }
      // Honor freshness / in-flight guards; do not force a blocking full sync.
      yield* pullRequests.ensureIndexed(input.projectId);
      return yield* index.search({
        projectId: input.projectId,
        providers: ["pull-request"],
        query: "",
        limit: 1,
      });
    }),

    thumbnail: Effect.fn("MentionIndexService.thumbnail")(function* (input) {
      if (!(yield* mentionIndexEnabled)) return { _tag: "Missing" as const };
      const blob = yield* index.getThumbnail(
        mentionIndexThumbKey(input.providerId, input.projectId, input.itemKey),
      );
      if (blob === null) return { _tag: "Missing" as const };
      return {
        _tag: "Present" as const,
        mimeType: blob.mimeType,
        dataBase64: blob.dataBase64,
      };
    }),

    figmaListTeams: Effect.fn("MentionIndexService.figmaListTeams")(function* (input) {
      if (!(yield* mentionIndexEnabled)) {
        return { teams: [], detail: MENTION_INDEX_DISABLED_DETAIL };
      }
      return yield* figma.listTeams(input);
    }),

    figmaListProjects: Effect.fn("MentionIndexService.figmaListProjects")(function* (input) {
      if (!(yield* mentionIndexEnabled)) {
        return { projects: [], detail: MENTION_INDEX_DISABLED_DETAIL };
      }
      return yield* figma.listProjects(input);
    }),
  });
});

export const layer = Layer.effect(MentionIndexService, make);
