import {
  GitActivityLogEntry,
  GitActivityLogError,
  GitPullRequestAssociation,
  ThreadId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface GitActivityRecord {
  readonly timestamp: string;
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly cwd: string;
  readonly threadId: ThreadId | null;
  readonly pullRequests: ReadonlyArray<typeof GitPullRequestAssociation.Type>;
  readonly isMutating: boolean;
}

export interface GitActivityLedgerShape {
  readonly record: (entry: GitActivityRecord) => Effect.Effect<void, GitActivityLogError>;
  readonly list: (input: {
    readonly all: boolean;
    readonly limit: number;
    readonly threadId?: ThreadId;
    readonly pullRequestNumber?: number;
  }) => Effect.Effect<ReadonlyArray<typeof GitActivityLogEntry.Type>, GitActivityLogError>;
}

export class GitActivityLedger extends Context.Service<GitActivityLedger, GitActivityLedgerShape>()(
  "t3/persistence/Services/GitActivityLedger",
) {}
