import { Stack } from "alchemy/Stack";
import * as State from "alchemy/State";
import * as Layer from "effect/Layer";

export const state = (resources: Record<string, State.ResourceState> = {}) =>
  Layer.effect(
    State.State,
    Stack.useSync((stack) =>
      State.InMemoryService({
        [stack.name]: {
          [stack.stage]: resources,
        },
      }),
    ),
  );

export const defaultState = (
  resources: Record<string, State.ResourceState> = {},
  other?: {
    [stack: string]: {
      [stage: string]: {
        [resourceId: string]: State.ResourceState;
      };
    };
  },
) =>
  Layer.succeed(
    State.State,
    State.InMemoryService({
      ["test-app"]: {
        ["test-stage"]: resources,
      },
      ...other,
    }),
  );
