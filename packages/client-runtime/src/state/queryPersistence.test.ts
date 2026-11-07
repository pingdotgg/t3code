import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EnvironmentQueryStore, persistQuery } from "./queryPersistence.ts";

import { persistPullRequestStats } from "./pullRequestStatsPersistence.ts";

const env = EnvironmentId.make("one");
const other = EnvironmentId.make("two");
const persisted = persistQuery(Schema.Struct({ title: Schema.String }));

function store(records = new Map<string, string>()) {
  return {
    load: (environmentId: EnvironmentId, key: string) =>
      Effect.sync(() => Option.fromUndefinedOr(records.get(`${environmentId}:${key}`))),
    save: (environmentId: EnvironmentId, key: string, payload: string) =>
      Effect.sync(() => {
        records.set(`${environmentId}:${key}`, payload);
      }),
  };
}

describe("query persistence", () => {
  it.effect("round trips responses without mixing environments or query scopes", () =>
    Effect.gen(function* () {
      yield* persisted.save(env, "open", { title: "saved" });
      expect(yield* persisted.load(env, "open")).toEqual(Option.some({ title: "saved" }));
      expect(yield* persisted.load(other, "open")).toEqual(Option.none());
      expect(yield* persisted.load(env, "closed")).toEqual(Option.none());
    }).pipe(Effect.provideService(EnvironmentQueryStore, store())),
  );

  it.effect("ignores corrupt or incompatible records", () =>
    Effect.gen(function* () {
      expect(yield* persisted.load(env, "broken")).toEqual(Option.none());
      expect(yield* persisted.load(env, "incompatible")).toEqual(Option.none());
    }).pipe(
      Effect.provideService(
        EnvironmentQueryStore,
        store(
          new Map([
            ["one:broken", "not json"],
            ["one:incompatible", '{"title":42}'],
          ]),
        ),
      ),
    ),
  );
});

it.effect("restores line counts when visible PR batches change", () =>
  Effect.gen(function* () {
    const cache = persistPullRequestStats();
    const first = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 };
    const second = { ...first, number: 2 };
    const stat = { ...first, additions: 42, deletions: 3 };
    yield* cache.save(env, JSON.stringify(["stats", { refs: [first, second] }]), { stats: [stat] });
    const key = JSON.stringify(["stats", { refs: [first] }]);
    expect(yield* cache.load(env, key)).toEqual(Option.some({ stats: [stat] }));
    expect(yield* cache.load(other, key)).toEqual(Option.none());
    const hosted = { ...stat, host: "github.com" };
    yield* cache.save(env, key, { stats: [hosted] });
    expect(yield* cache.load(env, key)).toEqual(Option.some({ stats: [hosted] }));
    const github = { ...first, host: "github.com" };
    const bitbucket = { ...first, host: "bitbucket.org" };
    const refs = [github, bitbucket];
    const stats = refs.map((ref) => ({
      ...ref,
      additions: ref.host === "github.com" ? 12 : 42,
      deletions: 3,
    }));
    yield* cache.save(env, JSON.stringify(["stats", { refs }]), { stats });
    for (const [index, ref] of refs.entries()) {
      expect(yield* cache.load(env, JSON.stringify(["stats", { refs: [ref] }]))).toEqual(
        Option.some({ stats: [stats[index]] }),
      );
    }
    const legacy = { ...stat, number: 3 };
    const legacyRefs = refs.map((ref) => ({ ...ref, number: 3 }));
    yield* cache.save(env, JSON.stringify(["stats", { refs: legacyRefs }]), { stats: [legacy] });
    expect(yield* cache.load(env, JSON.stringify(["stats", { refs: legacyRefs }]))).toEqual(
      Option.none(),
    );
    yield* cache.save(env, JSON.stringify(["stats", { refs: [legacyRefs[0]] }]), {
      stats: [legacy],
    });
    expect(yield* cache.load(env, JSON.stringify(["stats", { refs: [legacyRefs[0]] }]))).toEqual(
      Option.some({ stats: [{ ...legacy, host: "github.com" }] }),
    );
    const mixedRef = { ...github, number: 4 };
    const mixedStat = { ...mixedRef, additions: 17, deletions: 2 };
    yield* cache.save(
      env,
      JSON.stringify(["stats", { refs: [{ ...first, number: 4 }, mixedRef] }]),
      {
        stats: [mixedStat],
      },
    );
    expect(yield* cache.load(env, JSON.stringify(["stats", { refs: [mixedRef] }]))).toEqual(
      Option.some({ stats: [mixedStat] }),
    );
  }).pipe(Effect.provideService(EnvironmentQueryStore, store())),
);
