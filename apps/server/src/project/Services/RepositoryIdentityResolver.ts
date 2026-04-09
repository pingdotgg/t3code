import type { RepositoryIdentity } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface RepositoryIdentityResolverShape {
  readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
}

export class RepositoryIdentityResolver extends ServiceMap.Service<
  RepositoryIdentityResolver,
  RepositoryIdentityResolverShape
>()("t3/project/Services/RepositoryIdentityResolver") {}
