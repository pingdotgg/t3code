import { ApprovalRequestId, CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

export const newCommandId = (): CommandId => CommandId.makeUnsafe(crypto.randomUUID());

export const newProjectId = (): ProjectId => ProjectId.makeUnsafe(crypto.randomUUID());

export const newThreadId = (): ThreadId => ThreadId.makeUnsafe(crypto.randomUUID());

export const newMessageId = (): MessageId => MessageId.makeUnsafe(crypto.randomUUID());


export const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);

export const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
