import type { VcsBackend, VcsCapabilities } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { VcsServiceError } from "../Errors.ts";

export interface VcsResolution {
  readonly backend: VcsBackend;
  readonly capabilities: VcsCapabilities;
  readonly workspaceRoot: string;
}

export interface ResolveVcsBackendInput {
  readonly cwd: string;
  readonly backend?: VcsBackend | undefined;
}

export interface VcsResolverShape {
  readonly resolve: (
    input: ResolveVcsBackendInput,
  ) => Effect.Effect<VcsResolution, VcsServiceError>;
}

export class VcsResolver extends ServiceMap.Service<VcsResolver, VcsResolverShape>()(
  "t3/vcs/Services/VcsResolver",
) {}
