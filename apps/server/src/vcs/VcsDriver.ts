import { Context, type Effect } from "effect";

import type {
  VcsDriverCapabilities,
  VcsError,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  VcsRepositoryIdentity,
} from "@t3tools/contracts";
import type { VcsProcessInput, VcsProcessOutput } from "./VcsProcess.ts";

export interface VcsDriverShape {
  readonly capabilities: VcsDriverCapabilities;
  readonly execute: (
    input: Omit<VcsProcessInput, "command">,
  ) => Effect.Effect<VcsProcessOutput, VcsError>;
  readonly detectRepository: (cwd: string) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
  readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
  readonly listWorkspaceFiles: (
    cwd: string,
  ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
  readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
  readonly filterIgnoredPaths: (
    cwd: string,
    relativePaths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
}

export class VcsDriver extends Context.Service<VcsDriver, VcsDriverShape>()("t3/vcs/VcsDriver") {}
