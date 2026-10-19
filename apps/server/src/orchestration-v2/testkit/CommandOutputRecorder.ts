import type { TurnItemId } from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  type TerminalOutputState,
} from "@t3tools/shared/terminalOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CommandOutputHub from "../CommandOutputHub.ts";
import type * as EventSink from "../EventSink.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";

/** What one command streamed through the hub during a replay. */
export interface RecordedCommandOutput {
  readonly chunks: number;
  /** The live tail as a viewer would have seen it. */
  readonly output: TerminalOutputState;
}

export class CommandOutputRecorder extends Context.Service<
  CommandOutputRecorder,
  { readonly snapshot: Effect.Effect<ReadonlyMap<TurnItemId, RecordedCommandOutput>> }
>()("t3/orchestration-v2/testkit/CommandOutputRecorder") {}

/** The real hub, plus a record of every chunk it was given, keyed by turn item. */
export const layer: Layer.Layer<
  CommandOutputHub.CommandOutputHub | CommandOutputRecorder,
  never,
  EventSink.EventSinkV2 | ProjectionStore.ProjectionStoreV2
> = Layer.effectContext(
  Effect.gen(function* () {
    const hub = yield* CommandOutputHub.make;
    const recorded = new Map<TurnItemId, RecordedCommandOutput>();
    return Context.make(
      CommandOutputHub.CommandOutputHub,
      CommandOutputHub.CommandOutputHub.of({
        ...hub,
        append: (input) =>
          Effect.sync(() => {
            const previous = recorded.get(input.itemId);
            recorded.set(input.itemId, {
              chunks: (previous?.chunks ?? 0) + 1,
              output: appendTerminalOutput(previous?.output ?? EMPTY_TERMINAL_OUTPUT, input.chunk),
            });
          }).pipe(Effect.andThen(hub.append(input))),
      }),
    ).pipe(
      Context.add(CommandOutputRecorder, {
        snapshot: Effect.sync(() => new Map(recorded)),
      }),
    );
  }),
);
