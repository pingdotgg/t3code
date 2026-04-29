import { Context } from "effect";
import type { Effect, Stream } from "effect";
import type {
  GitManagerServiceError,
  GitStatusInput,
  GitStatusLocalResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "@t3tools/contracts";

export interface GitStatusBroadcasterShape {
  readonly getStatus: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;
  readonly refreshLocalStatus: (
    input: string | GitStatusInput,
  ) => Effect.Effect<GitStatusLocalResult, GitManagerServiceError>;
  readonly refreshStatus: (
    input: string | GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;
  readonly streamStatus: (
    input: GitStatusInput,
  ) => Stream.Stream<GitStatusStreamEvent, GitManagerServiceError>;
}

export class GitStatusBroadcaster extends Context.Service<
  GitStatusBroadcaster,
  GitStatusBroadcasterShape
>()("t3/git/Services/GitStatusBroadcaster") {}
