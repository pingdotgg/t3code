import { Context } from "effect";
import type { Effect, Stream } from "effect";
import type {
  GitManagerServiceError,
  GitStatusInput,
  GitStatusLocalResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "@harness/contracts";

export interface GitStatusBroadcasterShape {
  readonly getStatus: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;
  readonly refreshLocalStatus: (
    cwd: string,
  ) => Effect.Effect<GitStatusLocalResult, GitManagerServiceError>;
  readonly refreshStatus: (cwd: string) => Effect.Effect<GitStatusResult, GitManagerServiceError>;
  readonly streamStatus: (
    input: GitStatusInput,
  ) => Stream.Stream<GitStatusStreamEvent, GitManagerServiceError>;
}

export class GitStatusBroadcaster extends Context.Service<
  GitStatusBroadcaster,
  GitStatusBroadcasterShape
>()("harness/git/Services/GitStatusBroadcaster") {}
