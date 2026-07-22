import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { EnvRecord } from "../projectLaunchEnvUtils.ts";
import type {
  ProjectLaunchEnvProjectLookupError,
  ProjectLaunchEnvThreadLookupError,
} from "./ProjectLaunchEnvErrors.ts";

export interface ResolveProjectLaunchEnvInput {
  readonly projectRoot: string;
  readonly projectId: ProjectId | string;
  readonly threadId: ThreadId;
  readonly worktreePath?: string | null | undefined;
  readonly extraEnv?: EnvRecord;
}

export interface ResolveProjectLaunchEnvForThreadInput {
  readonly threadId: ThreadId;
  readonly terminalId?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly extraEnv?: EnvRecord;
}

export type ResolvedProjectLaunchEnvForThread = {
  readonly projectId: ProjectId;
  readonly worktreePath?: string | null | undefined;
  readonly env: Record<string, string>;
};

export class ProjectLaunchEnv extends Context.Service<
  ProjectLaunchEnv,
  {
    readonly resolve: (
      input: ResolveProjectLaunchEnvInput,
    ) => Effect.Effect<Record<string, string>>;
    readonly resolveForThread: (
      input: ResolveProjectLaunchEnvForThreadInput,
    ) => Effect.Effect<
      ResolvedProjectLaunchEnvForThread,
      ProjectLaunchEnvProjectLookupError | ProjectLaunchEnvThreadLookupError
    >;
  }
>()("t3/projectLaunchEnv/Services/ProjectLaunchEnv") {}
