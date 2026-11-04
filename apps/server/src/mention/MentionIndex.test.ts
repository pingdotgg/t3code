import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";

import { MentionIndex, make, mentionIndexScopeKey, type MentionIndexRow } from "./MentionIndex.ts";

const projectId = ProjectId.make("project-1");

const row = (
  partial: Partial<MentionIndexRow> & Pick<MentionIndexRow, "itemKey" | "label">,
): MentionIndexRow => ({
  providerId: "pull-request",
  description: partial.description ?? partial.label,
  url: partial.url ?? `https://github.com/org/repo/pull/${partial.itemKey}`,
  tokens: partial.tokens ?? `${partial.itemKey} ${partial.label}`.toLowerCase(),
  updatedAt: partial.updatedAt ?? 1,
  ...partial,
});

const testLayer = Layer.effect(MentionIndex, make).pipe(Layer.provide(KeyValueStore.layerMemory));

it.effect("searches locally without needing a network round trip", () =>
  Effect.gen(function* () {
    const index = yield* MentionIndex;
    const scopeKey = mentionIndexScopeKey("pull-request", projectId);
    yield* index.replaceScope(scopeKey, [
      row({
        itemKey: "org/repo#42",
        label: "#42",
        description: "Improve context chips",
        tokens: "42 #42 improve context chips org/repo",
        pullRequest: {
          number: 42,
          title: "Improve context chips",
          url: "https://github.com/org/repo/pull/42",
          headBranch: "feat/chips",
          baseBranch: "main",
          state: "open",
          isDraft: false,
          projectId,
          repository: "org/repo",
        },
      }),
      row({
        itemKey: "org/repo#7",
        label: "#7",
        description: "Unrelated",
        tokens: "7 #7 unrelated org/repo",
      }),
    ]);

    const result = yield* index.search({
      projectId,
      providers: ["pull-request"],
      query: "context",
      limit: 10,
    });

    expect(result.status).toBe("ready");
    expect(result.hits.map((hit) => hit.label)).toEqual(["#42"]);
    expect(result.hits[0]?.pullRequest?.number).toBe(42);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("ranks an exact number above a substring title hit", () =>
  Effect.gen(function* () {
    const index = yield* MentionIndex;
    const scopeKey = mentionIndexScopeKey("pull-request", projectId);
    yield* index.replaceScope(scopeKey, [
      row({
        itemKey: "org/repo#420",
        label: "#420",
        tokens: "420 #420 something else",
      }),
      row({
        itemKey: "org/repo#42",
        label: "#42",
        tokens: "42 #42 exact",
      }),
    ]);

    const result = yield* index.search({
      projectId,
      providers: ["pull-request"],
      query: "42",
      limit: 10,
    });

    expect(result.hits.map((hit) => hit.label)).toEqual(["#42", "#420"]);
  }).pipe(Effect.provide(testLayer)),
);
