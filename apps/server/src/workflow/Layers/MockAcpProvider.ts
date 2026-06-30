import type { TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ProviderTurnPort } from "../Services/ProviderDispatchOutbox.ts";
import { TurnProjectionPort } from "../Services/TurnStateReader.ts";

type MockTurnState = "running" | "completed" | "error";

interface MockTurn {
  readonly threadId: string;
  readonly turnId: TurnId;
  readonly state: MockTurnState;
}

interface MockAcpState {
  readonly startedCount: number;
  readonly turns: ReadonlyMap<string, MockTurn>;
}

export interface MockAcpProviderShape {
  readonly startedCount: Effect.Effect<number>;
  readonly completeAllRunning: () => Effect.Effect<void>;
}

export class MockAcpProvider extends Context.Service<MockAcpProvider, MockAcpProviderShape>()(
  "t3/workflow/Layers/MockAcpProvider",
) {}

export const MockAcpProviderLive = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Ref.make<MockAcpState>({
      startedCount: 0,
      turns: new Map(),
    });

    const providerTurnPort = ProviderTurnPort.of({
      ensureTurnStarted: (request) =>
        Ref.modify(state, (current) => {
          const existing = current.turns.get(request.threadId as string);
          if (existing) {
            return [{ turnId: existing.turnId }, current] as const;
          }

          const turn = {
            threadId: request.threadId as string,
            turnId: `turn-${request.threadId}` as TurnId,
            state: "running" as const,
          } satisfies MockTurn;
          const turns = new Map(current.turns);
          turns.set(turn.threadId, turn);
          return [
            { turnId: turn.turnId },
            { startedCount: current.startedCount + 1, turns },
          ] as const;
        }),
    });

    const turnProjectionPort = TurnProjectionPort.of({
      getLatestTurnState: (threadId) =>
        Ref.get(state).pipe(
          Effect.map((current) => {
            const turn = current.turns.get(threadId as string);
            return {
              state: turn?.state ?? "pending",
              completed: turn?.state === "completed" || turn?.state === "error",
            };
          }),
        ),
    });

    const mock = MockAcpProvider.of({
      startedCount: Ref.get(state).pipe(Effect.map((current) => current.startedCount)),
      completeAllRunning: () =>
        Ref.update(state, (current) => {
          const turns = new Map(current.turns);
          for (const [threadId, turn] of turns) {
            if (turn.state === "running") {
              turns.set(threadId, { ...turn, state: "completed" });
            }
          }
          return { ...current, turns };
        }),
    });

    return Layer.mergeAll(
      Layer.succeed(MockAcpProvider, mock),
      Layer.succeed(ProviderTurnPort, providerTurnPort),
      Layer.succeed(TurnProjectionPort, turnProjectionPort),
    );
  }),
);
