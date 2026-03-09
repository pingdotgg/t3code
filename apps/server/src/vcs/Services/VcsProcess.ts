import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { VcsCommandError } from "../Errors.ts";

export interface ExecuteVcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
}

export interface ExecuteVcsProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VcsProcessShape {
  readonly execute: (
    input: ExecuteVcsProcessInput,
  ) => Effect.Effect<ExecuteVcsProcessResult, VcsCommandError>;
}

export class VcsProcess extends ServiceMap.Service<VcsProcess, VcsProcessShape>()(
  "t3/vcs/Services/VcsProcess",
) {}
