import {
  InMemoryService,
  syncState,
  type ResourceState,
  type StateService,
} from "@/State";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("syncState", () => {
  it.effect(
    "copies source resources and overwrites matching destination resources",
    () =>
      Effect.gen(function* () {
        const sourceA = resource("resource-a", { value: "source-a" });
        const sourceB = resource("resource-b", { value: "source-b" });
        const destinationA = resource("resource-a", { value: "destination-a" });

        const source = yield* InMemoryService({
          app: {
            dev: {
              "resource-a": sourceA,
              "resource-b": sourceB,
            },
          },
        });
        const destination = yield* InMemoryService({
          app: {
            dev: {
              "resource-a": destinationA,
            },
          },
        });

        yield* syncState(source, destination);

        yield* expectStage(destination, "app", "dev", {
          "resource-a": sourceA,
          "resource-b": sourceB,
        });
      }),
  );

  it.effect(
    "deletes resources from destination when they are absent from source",
    () =>
      Effect.gen(function* () {
        const source = yield* InMemoryService({
          app: {
            dev: {
              "resource-a": resource("resource-a", { value: "source-a" }),
            },
          },
        });
        const destination = yield* InMemoryService({
          app: {
            dev: {
              "resource-a": resource("resource-a", { value: "destination-a" }),
              "resource-b": resource("resource-b", { value: "destination-b" }),
            },
            prod: {
              "resource-c": resource("resource-c", { value: "destination-c" }),
            },
          },
          oldApp: {
            dev: {
              "resource-d": resource("resource-d", { value: "destination-d" }),
            },
          },
        });

        yield* syncState(source, destination);

        yield* expectStage(destination, "app", "dev", {
          "resource-a": resource("resource-a", { value: "source-a" }),
        });
        yield* expectStage(destination, "app", "prod", {});
        yield* expectStage(destination, "oldApp", "dev", {});
        expect(yield* destination.listStacks()).toEqual(["app"]);
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

const listStage = Effect.fn(function* (
  state: StateService,
  stack: string,
  stage: string,
) {
  const fqns = yield* state.list({ stack, stage });
  const entries = yield* Effect.forEach(
    fqns,
    Effect.fn(function* (fqn) {
      return [fqn, yield* state.get({ stack, stage, fqn })] as const;
    }),
  );
  return Object.fromEntries(entries);
});

const expectStage = Effect.fn(function* (
  state: StateService,
  stack: string,
  stage: string,
  expected: Record<string, ResourceState>,
) {
  expect(yield* listStage(state, stack, stage)).toEqual(expected);
});
