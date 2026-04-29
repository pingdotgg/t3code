import type { RepositoryIdentity } from "@t3tools/contracts";
import type { ExecutionTarget } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface RepositoryIdentityResolveInput {
  readonly cwd: string;
  readonly executionTarget?: ExecutionTarget | undefined;
}

export interface RepositoryIdentityResolverShape {
  readonly resolve: (
    input: string | RepositoryIdentityResolveInput,
  ) => Effect.Effect<RepositoryIdentity | null>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  RepositoryIdentityResolverShape
>()("t3/project/Services/RepositoryIdentityResolver") {}
