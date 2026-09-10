import { exportState, InMemoryService, type ResourceState } from "@/State";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("exportState", () => {
  it.effect("exports every stack/stage/resource as one document", () =>
    Effect.gen(function* () {
      const state = yield* InMemoryService({
        "app-east": {
          dev: {
            WebServer: resource("WebServer", { instanceId: "i-1" }),
            Database: resource("Database", { arn: "arn:db" }),
          },
          prod: {
            WebServer: resource("WebServer", { instanceId: "i-2" }),
          },
        },
        "app-west": {
          dev: {
            Bucket: resource("Bucket", { bucketName: "b-1" }),
          },
        },
      });

      const exported = yield* exportState(state);

      // Deterministic order: stack, then stage, then FQN.
      expect(
        exported.resources.map((r) => `${r.stack}/${r.stage}/${r.fqn}`),
      ).toEqual([
        "app-east/dev/Database",
        "app-east/dev/WebServer",
        "app-east/prod/WebServer",
        "app-west/dev/Bucket",
      ]);

      // Records are the same values `state.get` returns — props/attr intact.
      const webServer = exported.resources.find(
        (r) =>
          r.stack === "app-east" && r.stage === "dev" && r.fqn === "WebServer",
      );
      expect(webServer?.state).toEqual(
        yield* state.get({ stack: "app-east", stage: "dev", fqn: "WebServer" }),
      );
    }),
  );

  it.effect("filters by stack", () =>
    Effect.gen(function* () {
      const state = yield* InMemoryService({
        "app-east": { dev: { A: resource("A", {}) } },
        "app-west": { dev: { B: resource("B", {}) } },
      });

      const exported = yield* exportState(state, { stack: "app-west" });

      expect(exported.resources.map((r) => `${r.stack}/${r.fqn}`)).toEqual([
        "app-west/B",
      ]);
    }),
  );

  it.effect("filters by stack and stage", () =>
    Effect.gen(function* () {
      const state = yield* InMemoryService({
        app: {
          dev: { A: resource("A", {}) },
          prod: { B: resource("B", {}) },
        },
      });

      const exported = yield* exportState(state, {
        stack: "app",
        stage: "prod",
      });

      expect(
        exported.resources.map((r) => `${r.stack}/${r.stage}/${r.fqn}`),
      ).toEqual(["app/prod/B"]);
    }),
  );

  it.effect("returns an empty document for an empty store", () =>
    Effect.gen(function* () {
      const state = yield* InMemoryService({});
      expect(yield* exportState(state)).toEqual({ resources: [] });
    }),
  );

  it.effect("tolerates a missing stack/stage filter target", () =>
    Effect.gen(function* () {
      const state = yield* InMemoryService({
        app: { dev: { A: resource("A", {}) } },
      });
      expect(yield* exportState(state, { stack: "nope" })).toEqual({
        resources: [],
      });
      expect(
        yield* exportState(state, { stack: "app", stage: "nope" }),
      ).toEqual({ resources: [] });
    }),
  );

  it.effect("skips records deleted between list and get", () =>
    Effect.gen(function* () {
      const inner = yield* InMemoryService({
        app: {
          dev: {
            A: resource("A", {}),
            B: resource("B", {}),
          },
        },
      });
      // Simulate a concurrent destroy racing the export: `list` still
      // returns the FQN but `get` comes back empty.
      const racy = {
        ...inner,
        get: (request: { stack: string; stage: string; fqn: string }) =>
          request.fqn === "A" ? Effect.succeed(undefined) : inner.get(request),
      };

      const exported = yield* exportState(racy);

      expect(exported.resources.map((r) => r.fqn)).toEqual(["B"]);
    }),
  );
});

const resource = (
  fqn: string,
  attr: Record<string, unknown>,
): ResourceState => ({
  resourceType: "test:resource",
  namespace: undefined,
  fqn,
  logicalId: fqn,
  instanceId: `instance-${fqn}`,
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: {},
  attr,
});
