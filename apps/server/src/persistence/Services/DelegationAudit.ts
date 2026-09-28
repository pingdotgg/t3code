import {
  DelegationAuditAppendInput,
  DelegationAuditBeginInput,
  DelegationAuditBeginResult,
  DelegationAuditError,
  DelegationAuditPage,
  DelegationAuditPageInput,
  MessageId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface DelegationAuditRepositoryShape {
  readonly begin: (
    input: DelegationAuditBeginInput & {
      readonly sourceTurnId: TurnId | null;
      readonly sourceMessageId: MessageId | null;
      readonly initiatingMessageId: MessageId | null;
    },
  ) => Effect.Effect<DelegationAuditBeginResult, ProjectionRepositoryError | DelegationAuditError>;
  readonly append: (
    input: DelegationAuditAppendInput,
  ) => Effect.Effect<void, ProjectionRepositoryError | DelegationAuditError>;
  readonly page: (
    input: DelegationAuditPageInput,
  ) => Effect.Effect<DelegationAuditPage, ProjectionRepositoryError | DelegationAuditError>;
  readonly getOperationSource: (
    operationId: string,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError | DelegationAuditError>;
  readonly getAttemptForChild: (childThreadId: ThreadId) => Effect.Effect<
    Option.Option<{
      readonly operationId: string;
      readonly attemptId: string;
      readonly sourceThreadId: ThreadId;
    }>,
    ProjectionRepositoryError | DelegationAuditError
  >;
  readonly deleteBySourceThreadId: (
    sourceThreadId: ThreadId,
  ) => Effect.Effect<void, ProjectionRepositoryError | DelegationAuditError>;
}

export class DelegationAuditRepository extends Context.Service<
  DelegationAuditRepository,
  DelegationAuditRepositoryShape
>()("t3/persistence/Services/DelegationAudit/DelegationAuditRepository") {}
