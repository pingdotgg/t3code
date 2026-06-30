import type { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type TurnState =
  | { readonly _tag: "running" }
  | { readonly _tag: "completed" }
  | {
      readonly _tag: "awaiting_user";
      readonly waitingReason: string;
      readonly providerThreadId: ThreadId;
      readonly providerRequestId: ApprovalRequestId;
      readonly providerResponseKind: "request" | "user-input";
      readonly providerQuestionId?: string;
    }
  | { readonly _tag: "failed"; readonly error: string };

export interface TurnProjectionPortShape {
  readonly getLatestTurnState: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly state: string; readonly completed: boolean }>;
}

export class TurnProjectionPort extends Context.Service<
  TurnProjectionPort,
  TurnProjectionPortShape
>()("t3/workflow/Services/TurnStateReader/TurnProjectionPort") {}

export interface TurnStateReaderShape {
  readonly read: (threadId: ThreadId) => Effect.Effect<TurnState>;
}

export class TurnStateReader extends Context.Service<TurnStateReader, TurnStateReaderShape>()(
  "t3/workflow/Services/TurnStateReader",
) {}
