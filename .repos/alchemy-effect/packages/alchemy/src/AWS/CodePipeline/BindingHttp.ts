import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Shared scaffolding for AWS CodePipeline HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action, and the injected
 * pipeline-name key is boilerplate.
 *
 * CodePipeline addresses the pipeline as `name` on some operations
 * (StartPipelineExecution, GetPipelineState) and `pipelineName` on the rest.
 * Stage- and action-addressed operations authorize against sub-resource ARNs
 * (`{pipelineArn}/{stage}` / `{pipelineArn}/{stage}/{action}`) — set
 * `subScoped` to additionally grant on `{pipelineArn}/*`.
 */

const bindPipelinePolicy = Effect.fn(function* (
  tag: string,
  pipeline: Pipeline,
  actions: readonly string[],
  subScoped: boolean | undefined,
) {
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const host = yield* Binding.Host;
    if (isBindingHost(host)) {
      yield* host.bind`Allow(${host}, ${tag}(${pipeline}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: [...actions],
            Resource: [
              Output.interpolate`${pipeline.pipelineArn}`,
              ...(subScoped
                ? [Output.interpolate`${pipeline.pipelineArn}/*`]
                : []),
            ],
          },
        ],
      });
    }
  }
});

/**
 * Build the impl Effect for an operation that addresses the pipeline via a
 * `name` field (StartPipelineExecution, GetPipelineState): the runtime
 * callable injects the bound {@link Pipeline}'s name and the deploy-time
 * half grants `actions` on the pipeline ARN.
 */
export const makeCodePipelineNameHttpBinding = <
  I extends { name?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodePipeline.GetPipelineState`. */
  tag: string;
  /** The distilled operation; `name` is injected from the pipeline. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the pipeline ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <P extends Pipeline>(pipeline: P) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const PipelineName = yield* pipeline.pipelineName;
      yield* bindPipelinePolicy(options.tag, pipeline, options.actions, false);
      return Effect.fn(`${options.tag}(${pipeline.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* op({
          ...request,
          name: yield* PipelineName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation that addresses the pipeline via a
 * `pipelineName` field (the majority): the runtime callable injects the
 * bound {@link Pipeline}'s name and the deploy-time half grants `actions`
 * on the pipeline ARN (plus `{pipelineArn}/*` when `subScoped` — stage- and
 * action-addressed operations authorize against sub-resource ARNs).
 */
export const makeCodePipelinePipelineNameHttpBinding = <
  I extends { pipelineName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodePipeline.RollbackStage`. */
  tag: string;
  /** The distilled operation; `pipelineName` is injected from the pipeline. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the pipeline ARN. */
  actions: readonly string[];
  /** Also grant on `{pipelineArn}/*` (stage-/action-addressed actions). */
  subScoped?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <P extends Pipeline>(pipeline: P) {
      const PipelineName = yield* pipeline.pipelineName;
      yield* bindPipelinePolicy(
        options.tag,
        pipeline,
        options.actions,
        options.subScoped,
      );
      return Effect.fn(`${options.tag}(${pipeline.LogicalId})`)(function* (
        request?: Omit<I, "pipelineName">,
      ) {
        return yield* op({
          ...request,
          pipelineName: yield* PipelineName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a job-worker operation (GetJobDetails,
 * PutJobSuccessResult, PutJobFailureResult). CodePipeline job actions do
 * not support resource-level permissions, so the deploy-time half grants
 * `actions` on `*`; the runtime callable passes the request through as-is.
 */
export const makeCodePipelineJobHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodePipeline.PutJobSuccessResult`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*` (no resource-level permission support). */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* op(request);
      });
    });
  });
