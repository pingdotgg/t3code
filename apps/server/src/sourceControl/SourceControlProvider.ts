import { Context, Effect } from "effect";
import type {
  SourceControlProviderError,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
  SourceControlRepositoryVisibility,
} from "@forma/contracts";

export interface SourceControlProviderShape {
  readonly kind: SourceControlProviderKind;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderShape
>()("forma/source-control/SourceControlProvider") {}
