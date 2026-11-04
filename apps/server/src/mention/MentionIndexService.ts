import type {
  MentionIndexProviderId,
  MentionIndexSearchInput,
  MentionIndexSearchResult,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MentionIndex } from "./MentionIndex.ts";
import { MentionIndexFigmaSyncer } from "./MentionIndexFigmaSyncer.ts";
import { MentionIndexJiraSyncer } from "./MentionIndexJiraSyncer.ts";
import { MentionIndexPrSyncer } from "./MentionIndexPrSyncer.ts";
import { MentionIndexThreadSyncer } from "./MentionIndexThreadSyncer.ts";

export class MentionIndexService extends Context.Service<
  MentionIndexService,
  {
    readonly search: (input: MentionIndexSearchInput) => Effect.Effect<MentionIndexSearchResult>;
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<MentionIndexSearchResult>;
  }
>()("t3/mention/MentionIndexService") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const pullRequests = yield* MentionIndexPrSyncer;
  const threads = yield* MentionIndexThreadSyncer;
  const jira = yield* MentionIndexJiraSyncer;
  const figma = yield* MentionIndexFigmaSyncer;

  const ensureProviders = Effect.fn("MentionIndexService.ensureProviders")(function* (
    projectId: ProjectId,
    providers: ReadonlyArray<MentionIndexProviderId>,
  ) {
    if (providers.includes("pull-request")) yield* pullRequests.ensureIndexed(projectId);
    if (providers.includes("thread")) yield* threads.ensureIndexed(projectId);
    if (providers.includes("jira")) yield* jira.ensureIndexed(projectId);
    if (providers.includes("figma")) yield* figma.ensureIndexed(projectId);
  });

  return MentionIndexService.of({
    search: Effect.fn("MentionIndexService.search")(function* (input) {
      const providers = input.providers ?? (["pull-request"] as const);
      yield* ensureProviders(input.projectId, providers);
      return yield* index.search(input);
    }),

    ensureIndexed: Effect.fn("MentionIndexService.ensureIndexed")(function* (projectId) {
      yield* pullRequests.syncProject(projectId);
      return yield* index.search({
        projectId,
        providers: ["pull-request"],
        query: "",
        limit: 1,
      });
    }),
  });
});

export const layer = Layer.effect(MentionIndexService, make);
