import { getProjectBranchAiGateway } from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import * as Namespace from "../Namespace.ts";
import * as Output from "../Output.ts";
import { InvalidBranchScope, resolveBranchScope } from "./BranchScope.ts";
import type { Credential } from "./Credential.ts";

export type AIGatewayProps = (
  | {
      /** Branch resource or explicit identity; output references are accepted. */
      branch:
        | import("./Branch.ts").Branch
        | {
            projectId: string | Output.Output<string>;
            branchId: string | Output.Output<string>;
          };
      project?: never;
    }
  | {
      /** Project resource or identity whose default branch supplies the gateway. */
      project:
        | import("./Project.ts").Project
        | {
            projectId: string | Output.Output<string>;
          };
      branch?: never;
    }
) & {
  /** Optional managed branch credential with ai_gateway:invoke permission. */
  credential?: Credential;
};

export interface AIGateway {
  /** Construct identity, used for deterministic binding names. */
  readonly FQN: string;
  /** Local construct identity. */
  readonly LogicalId: string;
  /** Declared scope and credential, retained for binding identity. */
  readonly Props: AIGatewayProps;
  /** Endpoint's owning project. */
  readonly projectId: Output.Output<string>;
  /** Endpoint's owning branch. */
  readonly branchId: Output.Output<string>;
  /** Gateway root, before the chat or Responses dialect path. */
  readonly baseUrl: Output.Output<string>;
  /** Optional explicit credential; never an account deployment API key. */
  readonly credential: Credential | undefined;
}

/**
 * Discover a branch AI Gateway endpoint without inventing gateway CRUD. The
 * construct never purchases credits or changes the account plan. Native Neon
 * Functions use injected credentials; QueryAIGatewayHttp owns a scoped service
 * credential when none is supplied. Model access and credits remain separate.
 *
 * ### Connect an existing branch
 * **Example:** Gateway configuration
 * ```typescript
 * const gateway = yield* Neon.AIGateway("AI", { branch });
 * // In a Function init Effect:
 * const ai = yield* Neon.QueryAIGateway(gateway);
 * const model = ai.model({ model: "gpt-5-mini" });
 * // Provide model to Effect AI generateText/generateObject/streamText in a handler.
 * ```
 *
 * ### Use output references explicitly
 * **Example:** Discover a gateway from a project's and branch's outputs
 * ```typescript
 * const gateway = yield* Neon.AIGateway("AI", {
 *   branch: { projectId: project.projectId, branchId: branch.branchId },
 * });
 * ```
 *
 * @resource
 * @product AI Gateway
 * @category AI Gateway
 */
export const AIGateway = Effect.fn(function* (
  id: string,
  props: AIGatewayProps,
) {
  if ((props.branch !== undefined) === (props.project !== undefined)) {
    return yield* Effect.die(
      new InvalidBranchScope({
        message: "Specify exactly one of branch or project",
      }),
    );
  }
  const namespace = yield* Namespace.CurrentChain;
  const projectId = Output.asOutput(
    props.branch?.projectId ?? props.project!.projectId,
  );
  const branchId = props.branch
    ? Output.asOutput(props.branch.branchId)
    : projectId.pipe(
        Output.mapEffect((projectId) =>
          resolveBranchScope({ project: { projectId } }).pipe(
            Effect.map((scope) => scope.branchId),
            Effect.orDie,
          ),
        ),
      );
  const baseUrl = Output.all(projectId, branchId).pipe(
    Output.mapEffect(([project_id, branch_id]) =>
      getProjectBranchAiGateway({ project_id, branch_id }).pipe(
        Effect.map((gateway) => gateway.base_url.replace(/\/$/, "")),
        Effect.orDie,
      ),
    ),
  );
  return {
    FQN: [...namespace.toReversed(), id].join("/"),
    LogicalId: id,
    Props: props,
    projectId,
    branchId,
    baseUrl,
    credential: props.credential,
  } satisfies AIGateway;
});
