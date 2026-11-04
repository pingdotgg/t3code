import type {
  MentionIndexSearchInput,
  MentionIndexSearchResult,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MentionIndex } from "./MentionIndex.ts";
import { MentionIndexPrSyncer } from "./MentionIndexPrSyncer.ts";

export class MentionIndexService extends Context.Service<
  MentionIndexService,
  {
    readonly search: (input: MentionIndexSearchInput) => Effect.Effect<MentionIndexSearchResult>;
    readonly ensureIndexed: (projectId: ProjectId) => Effect.Effect<MentionIndexSearchResult>;
  }
>()("t3/mention/MentionIndexService") {}

const make = Effect.gen(function* () {
  const index = yield* MentionIndex;
  const syncer = yield* MentionIndexPrSyncer;

  return MentionIndexService.of({
    search: Effect.fn("MentionIndexService.search")(function* (input) {
      const providers = input.providers ?? (["pull-request"] as const);
      if (providers.includes("pull-request")) {
        yield* syncer.ensureIndexed(input.projectId);
      }
      return yield* index.search(input);
    }),

    ensureIndexed: Effect.fn("MentionIndexService.ensureIndexed")(function* (projectId) {
      yield* syncer.syncProject(projectId);
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
