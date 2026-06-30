import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayBoardTicketState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface WorkflowBoardNotificationRelayShape {
  readonly publishTicket: (input: {
    readonly environmentId: EnvironmentId;
    readonly boardId: string;
    readonly ticketId: string;
    readonly state: RelayBoardTicketState;
  }) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowBoardNotificationRelay extends Context.Service<
  WorkflowBoardNotificationRelay,
  WorkflowBoardNotificationRelayShape
>()("t3/workflow/Services/WorkflowBoardNotificationRelay") {}
