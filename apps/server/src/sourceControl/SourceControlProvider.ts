import { Context, Effect } from "effect";
import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderError,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";

export interface SourceControlProviderContext {
  readonly provider: SourceControlProviderInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
}

export interface SourceControlRefSelector {
  readonly refName: string;
  readonly owner?: string;
  readonly repository?: string;
}

export interface SourceControlProviderShape {
  readonly kind: SourceControlProviderKind;
  readonly listChangeRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly source?: SourceControlRefSelector;
    readonly headSelector: string;
    readonly state: ChangeRequestState | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
  readonly getChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<ChangeRequest, SourceControlProviderError>;
  readonly createChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly source?: SourceControlRefSelector;
    readonly target?: SourceControlRefSelector;
    readonly baseRefName: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<string | null, SourceControlProviderError>;
  readonly checkoutChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, SourceControlProviderError>;
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderShape
>()("t3/source-control/SourceControlProvider") {}
