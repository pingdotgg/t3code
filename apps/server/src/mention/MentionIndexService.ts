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

const MENTION_INDEX_DISABLED_DETAIL = "Mention index is off. Turn it on in Settings → Labs.";

export class MentionIndexService extends Context.Service<
  MentionIndexService,
  {
    readonly search: (input: MentionIndexSearchInput) => Effect.Effect<MentionIndexSearchResult>;
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<MentionIndexSearchResult>;
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

  return MentionIndexService.of({
    search: Effect.fn("MentionIndexService.search")(function* (input) {
      if (!(yield* mentionIndexEnabled)) return disabledSearch();
      const providers = input.providers ?? (["pull-request"] as const);
      yield* ensureProviders(input.projectId, providers);
      return yield* index.search(input);
    }),

    ensureIndexed: Effect.fn("MentionIndexService.ensureIndexed")(function* (projectId) {
      if (!(yield* mentionIndexEnabled)) return disabledSearch();
      // Honor freshness / in-flight guards; do not force a blocking full sync.
      yield* pullRequests.ensureIndexed(projectId);
      return yield* index.search({
        projectId,
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
