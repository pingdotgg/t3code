import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import type { ResourceState } from "./ResourceState.ts";
import { State, type PersistedState } from "./State.ts";

type StackId = string;
type StageId = string;
type Fqn = string;

export const inMemoryState = (
  initialState: Record<
    StackId,
    Record<StageId, Record<Fqn, ResourceState>>
  > = {},
  initialOutputs: Record<StackId, Record<StageId, unknown>> = {},
) =>
  Layer.effect(
    State,
    Effect.cached(
      InMemoryService(initialState, initialOutputs).pipe(recordStateStoreInit),
    ),
  );

export const InMemoryService = (
  state: Record<StackId, Record<StageId, Record<Fqn, ResourceState>>> = {},
  outputs: Record<StackId, Record<StageId, unknown>> = {},
) =>
  State.of(
    Effect.succeed({
      id: "inmemory",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () => Effect.succeed(Array.from(Object.keys(state))),
      listStages: (stack: string) =>
        Effect.succeed(
          Array.from(stack in state ? Object.keys(state[stack]) : []),
        ),
      get: ({
        stack,
        stage,
        fqn,
      }: {
        stack: string;
        stage: string;
        fqn: string;
      }) => Effect.succeed(state[stack]?.[stage]?.[fqn]),
      getReplacedResources: ({
        stack,
        stage,
      }: {
        stack: string;
        stage: string;
      }) =>
        Effect.succeed(
          Array.from(Object.values(state[stack]?.[stage] ?? {}) ?? []).filter(
            (s) => s.status === "replaced",
          ),
        ),
      set: <V extends PersistedState>({
        stack,
        stage,
        fqn,
        value,
      }: {
        stack: string;
        stage: string;
        fqn: string;
        value: V;
      }) =>
        Effect.sync(() => {
          const stackState = (state[stack] ??= {});
          const stageState = (stackState[stage] ??= {});
          stageState[fqn] = value as ResourceState;
          return value;
        }),
      delete: ({
        stack,
        stage,
        fqn,
      }: {
        stack: string;
        stage: string;
        fqn: string;
      }) => Effect.sync(() => delete state[stack]?.[stage]?.[fqn]),
      deleteStack: ({ stack, stage }: { stack: string; stage?: string }) =>
        Effect.sync(() => {
          if (stage === undefined) {
            delete state[stack];
          } else {
            delete state[stack]?.[stage];
          }
        }),
      list: ({ stack, stage }: { stack: string; stage: string }) =>
        Effect.succeed(
          Array.from(Object.keys(state[stack]?.[stage] ?? {}) ?? []),
        ),
      getOutput: ({ stack, stage }: { stack: string; stage: string }) =>
        Effect.succeed(outputs[stack]?.[stage]),
      setOutput: ({
        stack,
        stage,
        value,
      }: {
        stack: string;
        stage: string;
        value: unknown;
      }) =>
        Effect.sync(() => {
          const stackOutputs = (outputs[stack] ??= {});
          stackOutputs[stage] = value;
          return value;
        }),
    }),
  );
