import { inMemoryState } from "@/State/InMemoryState.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import { deleteState, listState, readState } from "@/State/Tree.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

const resource = {
  resourceType: "test:resource",
  namespace: undefined,
  fqn: "resource",
  logicalId: "resource",
  instanceId: "instance-resource",
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: {},
  attr: { value: 1 },
} as ResourceState;

const state = () =>
  inMemoryState(
    { app: { dev: { resource } } },
    { app: { dev: { url: "https://example.com" } } },
  );

describe("State tree", () => {
  it.effect("queries state as structured data", () =>
    Effect.gen(function* () {
      expect(yield* listState({})).toEqual(["app/"]);
      expect(yield* listState({ path: "app/dev", recursive: true })).toEqual([
        "app/dev/resource",
        "app/dev/output",
      ]);

      expect(yield* readState({ path: "app/dev/output" })).toEqual([
        {
          path: "app/dev/output",
          kind: "output",
          value: { url: "https://example.com" },
        },
      ]);
    }).pipe(Effect.provide(state())),
  );

  it.effect("deletes subtrees and reports what was removed", () =>
    Effect.gen(function* () {
      const deleted = yield* deleteState({ path: "app/dev", recursive: true });

      expect(deleted).toEqual({
        _tag: "StateDeleted",
        path: "app/dev",
        deleted: ["app/dev/resource", "app/dev/output"],
      });
      expect(yield* listState({ path: "app" })).toEqual([]);
    }).pipe(Effect.provide(state())),
  );
});
