import { ServiceMap } from "effect";
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
    cwd: string,
  ) => Effect.Effect<GitStatusLocalResult, GitManagerServiceError>;
  readonly refreshStatus: (cwd: string) => Effect.Effect<GitStatusResult, GitManagerServiceError>;
  readonly streamStatus: (
    input: GitStatusInput,
  ) => Stream.Stream<GitStatusStreamEvent, GitManagerServiceError>;
}

export class GitStatusBroadcaster extends ServiceMap.Service<
  GitStatusBroadcaster,
  GitStatusBroadcasterShape
>()("t3/git/Services/GitStatusBroadcaster") {}
