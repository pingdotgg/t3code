import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { EnvRecord } from "../launchEnvUtils.ts";
import { LaunchEnvProjectLookupError, LaunchEnvThreadLookupError } from "./LaunchEnvErrors.ts";

export interface ResolveLaunchEnvInput {
  readonly projectRoot: string;
  readonly projectId: ProjectId | string;
  readonly threadId: ThreadId;
  readonly worktreePath?: string | null | undefined;
  readonly extraEnv?: EnvRecord;
}

export interface ResolveLaunchEnvForThreadInput {
  readonly threadId: ThreadId;
  readonly terminalId?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly extraEnv?: EnvRecord;
}

export type ResolvedLaunchEnvForThread = {
  readonly projectId: ProjectId;
  readonly worktreePath?: string | null | undefined;
  readonly env: Record<string, string>;
};

export interface LaunchEnvShape {
  readonly resolve: (input: ResolveLaunchEnvInput) => Effect.Effect<Record<string, string>>;
  readonly resolveForThread: (
    input: ResolveLaunchEnvForThreadInput,
  ) => Effect.Effect<
    ResolvedLaunchEnvForThread,
    LaunchEnvProjectLookupError | LaunchEnvThreadLookupError
  >;
}

export class LaunchEnv extends Context.Service<LaunchEnv, LaunchEnvShape>()(
  "t3/launchEnv/Services/LaunchEnv",
) {}
