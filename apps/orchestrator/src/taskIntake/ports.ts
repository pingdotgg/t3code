import type {
  TaskIntakeDeliveryResult,
  TaskIntakeExternalLinkKind,
  TaskIntakeMessage,
  TaskIntakeReply,
} from "./contracts.ts";

export interface TaskIntakeExistingTask {
  readonly taskId: string;
  readonly projectId?: string;
  readonly t3ThreadId?: string;
}

export type TaskIntakeStoredEvent =
  | {
      readonly status: "duplicate";
      readonly taskId?: string;
    }
  | {
      readonly status: "created";
      readonly taskId: string;
      readonly projectId?: string;
    }
  | {
      readonly status: "routed_existing";
      readonly taskId: string;
      readonly projectId?: string;
      readonly t3ThreadId?: string;
    };

export interface TaskIntakeStore {
  readonly resolveMessage: (input: {
    readonly message: TaskIntakeMessage;
    readonly externalLink: {
      readonly kind: TaskIntakeExternalLinkKind;
      readonly externalId: string;
    };
    readonly title: string;
  }) => Promise<TaskIntakeStoredEvent>;

  readonly recordStartFailed: (input: {
    readonly message: TaskIntakeMessage;
    readonly taskId: string;
    readonly summary: string;
  }) => Promise<void>;
}

export interface TaskIntakeRuntimeMaterialization {
  readonly taskId: string;
  readonly workSessionId: string;
  readonly t3ProjectId: string;
  readonly t3ThreadId: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly acceptedAt: string;
}

export interface TaskIntakeRuntime {
  readonly materializeTaskRuntime: (input: {
    readonly taskId: string;
    readonly initialPrompt: string;
    readonly startCodingAgent: boolean;
  }) => Promise<TaskIntakeRuntimeMaterialization>;
}

export interface TaskIntakeReplyTransport {
  readonly postReply: (reply: TaskIntakeReply) => Promise<TaskIntakeDeliveryResult>;
}
