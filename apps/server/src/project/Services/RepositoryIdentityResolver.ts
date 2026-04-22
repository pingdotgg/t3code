import type { RepositoryIdentity } from "@harness/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface RepositoryIdentityResolverShape {
  readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  RepositoryIdentityResolverShape
>()("harness/project/Services/RepositoryIdentityResolver") {}
