import type * as amp from "@distilled.cloud/aws/amp";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for `aps:DescribeWorkspace`.
 *
 * Bind this operation to a {@link Workspace} inside a function runtime to get
 * a callable that reads the workspace's control-plane metadata (status,
 * alias, endpoint). Provide the `DescribeWorkspaceHttp` layer on the Function
 * to satisfy the binding.
 *
 * @binding
 * @section Workspace Metadata
 * @example Describe the Bound Workspace
 * ```typescript
 * const describeWorkspace = yield* AMP.DescribeWorkspace(workspace);
 *
 * const response = yield* describeWorkspace();
 * const status = response.workspace.status.statusCode;
 * ```
 */
export interface DescribeWorkspace extends Binding.Service<
  DescribeWorkspace,
  "AWS.AMP.DescribeWorkspace",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    () => Effect.Effect<
      amp.DescribeWorkspaceResponse,
      amp.DescribeWorkspaceError
    >
  >
> {}
export const DescribeWorkspace = Binding.Service<DescribeWorkspace>(
  "AWS.AMP.DescribeWorkspace",
);
