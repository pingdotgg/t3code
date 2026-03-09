import type {
  VcsCheckoutRefInput,
  VcsCreateRefInput,
  VcsCreateWorkspaceInput,
  VcsCreateWorkspaceResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRemoveWorkspaceInput,
  VcsStatusInput,
  VcsStatusResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

import type { VcsServiceError } from "../Errors.ts";

export interface VcsCoreShape {
  readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, VcsServiceError>;
  readonly listRefs: (
    input: VcsListRefsInput,
  ) => Effect.Effect<VcsListRefsResult, VcsServiceError>;
  readonly createWorkspace: (
    input: VcsCreateWorkspaceInput,
  ) => Effect.Effect<VcsCreateWorkspaceResult, VcsServiceError>;
  readonly removeWorkspace: (
    input: VcsRemoveWorkspaceInput,
  ) => Effect.Effect<void, VcsServiceError>;
  readonly createRef: (input: VcsCreateRefInput) => Effect.Effect<void, VcsServiceError>;
  readonly checkoutRef: (
    input: VcsCheckoutRefInput,
  ) => Effect.Effect<void, VcsServiceError, Scope.Scope>;
  readonly init: (input: VcsInitInput) => Effect.Effect<void, VcsServiceError>;
}

export class VcsCore extends ServiceMap.Service<VcsCore, VcsCoreShape>()(
  "t3/vcs/Services/VcsCore",
) {}
