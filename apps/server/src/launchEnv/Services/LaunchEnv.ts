import {
  ProjectId,
  TerminalCwdError,
  TerminalSessionLookupError,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { EnvRecord } from "../launchEnvUtils.ts";

export interface ResolveLaunchEnvInput {
  readonly projectRoot: string;
  readonly projectId: ProjectId | string;
  readonly threadId: string;
  readonly worktreePath?: string | null;
  readonly extraEnv?: EnvRecord;
}

export interface ResolveLaunchEnvForThreadInput {
  readonly threadId: string;
  readonly terminalId?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly extraEnv?: EnvRecord;
}

export type ResolvedLaunchEnvForThread = {
  readonly projectId: ProjectId;
  readonly worktreePath?: string | null;
  readonly env: Record<string, string>;
};

export interface LaunchEnvShape {
  readonly resolve: (input: ResolveLaunchEnvInput) => Effect.Effect<Record<string, string>>;
  readonly resolveForThread: (
    input: ResolveLaunchEnvForThreadInput,
  ) => Effect.Effect<ResolvedLaunchEnvForThread, TerminalCwdError | TerminalSessionLookupError>;
}

export interface LaunchEnvProjectionShape {
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;
}

export class LaunchEnv extends Context.Service<LaunchEnv, LaunchEnvShape>()(
  "t3/launchEnv/Services/LaunchEnv",
) {}
