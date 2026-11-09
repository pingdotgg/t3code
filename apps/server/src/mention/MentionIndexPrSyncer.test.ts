import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { MentionIndex, make, mentionIndexScopeKey } from "./MentionIndex.ts";
import { MentionIndexPrSyncer, layer as prSyncerLayer } from "./MentionIndexPrSyncer.ts";

const projectId = ProjectId.make("project-1");

const detail = {
  provider: "github" as const,
  capabilities: {
    search: true,
    actions: [],
  },
  viewerPermissions: {
    canComment: true,
    canEdit: false,
    canMerge: false,
    canUpdateBranch: false,
  },
  projectId,
  projectTitle: "App",
  workspaceRoot: "/tmp/app",
  repository: "acme/app",
  number: 99,
  title: "Exact write-through",
  body: "",
  url: "https://github.com/acme/app/pull/99",
  author: null,
  state: "open" as const,
  isDraft: false,
  mergeability: "MERGEABLE" as const,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feat",
  baseBranch: "main",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: {
    methods: [],
    defaultMethod: null,
  },
};

const indexLayer = Layer.effect(MentionIndex, make).pipe(Layer.provide(KeyValueStore.layerMemory));

const testLayer = prSyncerLayer.pipe(
  Layer.provide(indexLayer),
  Layer.provide(
    Layer.succeed(PullRequestService.PullRequestService, {
      detail: () => Effect.succeed(detail),
      list: () =>
        Effect.succeed({
          viewers: {},
          providers: [],
          entries: [],
          nextCursors: {},
          truncated: false,
          errors: [],
        }),
    } as never),
  ),
  Layer.provideMerge(indexLayer),
);

it.effect("ensureExact fetches a PR and upserts it into the index", () =>
  Effect.gen(function* () {
    const syncer = yield* MentionIndexPrSyncer;
    const index = yield* MentionIndex;

    yield* syncer.ensureExact(projectId, { number: 99, repository: "acme/app" });

    const result = yield* index.search({
      projectId,
      providers: ["pull-request"],
      query: "99",
      limit: 5,
    });
    expect(result.hits.map((hit) => hit.itemKey)).toEqual(["acme/app#99"]);
    expect(result.hits[0]?.pullRequest).toMatchObject({
      number: 99,
      title: "Exact write-through",
      repository: "acme/app",
      projectId,
    });
    const scope = yield* index.scopeMeta(mentionIndexScopeKey("pull-request", projectId));
    // Write-through must not pretend the whole scope was replaced.
    expect(scope?.syncedAt).toBe(0);
    expect(scope?.status).toBe("ready");
  }).pipe(Effect.provide(testLayer)),
);
