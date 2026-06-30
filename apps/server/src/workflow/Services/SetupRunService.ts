import type { SetupRunId, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface SetupTerminalPortShape {
  readonly launch: (input: {
    readonly threadId?: string;
    readonly projectId?: string;
    readonly projectCwd?: string;
    readonly worktreePath: string;
    readonly preferredTerminalId?: string;
  }) => Effect.Effect<
    { readonly threadId: string; readonly terminalId: string | null },
    WorkflowEventStoreError
  >;
  readonly awaitExit: (input: {
    readonly threadId: string;
    readonly terminalId: string | null;
    readonly timeoutMs?: number;
  }) => Effect.Effect<{ readonly exitCode: number }, WorkflowEventStoreError>;
}

export class SetupTerminalPort extends Context.Service<SetupTerminalPort, SetupTerminalPortShape>()(
  "t3/workflow/Services/SetupRunService/SetupTerminalPort",
) {}

export type SetupStatus = "completed" | "failed" | "timed_out";

export interface SetupRunServiceShape {
  readonly runSetup: (
    ticketId: TicketId,
    worktreeRef: string,
    worktreePath: string,
    setupRunId: SetupRunId,
    // Required by the setup runner to resolve the project — a worktree path
    // alone cannot, and workspace-root matching breaks under canonicalization.
    projectId?: string,
  ) => Effect.Effect<
    { readonly status: SetupStatus; readonly exitCode: number | null },
    WorkflowEventStoreError
  >;
}

export class SetupRunService extends Context.Service<SetupRunService, SetupRunServiceShape>()(
  "t3/workflow/Services/SetupRunService",
) {}
