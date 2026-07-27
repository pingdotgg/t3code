import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { JobQueue } from "./JobQueue.ts";

/**
 * Shared scaffolding for AWS Batch HTTP bindings.
 *
 * NOT exported from `index.ts` — every queue-anchored `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the two builders below. Everything except the operation, the IAM action
 * list, and (for queue-scoped operations) the injected `jobQueue` is
 * boilerplate. `SubmitJobHttp` binds TWO resources (queue + job definition)
 * and injects both, so it stays bespoke.
 */

/**
 * Build the impl Effect for a job-level operation (describe/terminate/cancel
 * submitted jobs). The bound {@link JobQueue} anchors the binding's identity;
 * the deploy-time half grants `actions` on `*` because job ARNs
 * (`arn:…:job/{jobId}`) are only known at runtime and `batch:DescribeJobs` /
 * `batch:ListJobs` have no resource-level IAM at all.
 */
export const makeBatchJobHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Batch.DescribeJobs`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (queue: JobQueue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${queue}))`({
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
      return Effect.fn(`${options.tag}(${queue.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });

/**
 * Build the impl Effect for a queue-scoped operation: the runtime callable
 * injects the bound {@link JobQueue}'s ARN as `jobQueue` and the deploy-time
 * half grants `actions` on the queue ARN (or `*` when the action has no
 * resource-level IAM).
 */
export const makeBatchQueueHttpBinding = <
  I extends { jobQueue?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Batch.ListJobs`. */
  tag: string;
  /** The distilled operation; `jobQueue` is injected from the bound queue. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the queue ARN (or `*` — see `wildcardIam`). */
  actions: readonly string[];
  /** Grant on `*` instead of the queue ARN (actions without resource-level IAM). */
  wildcardIam?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (queue: JobQueue) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const JobQueueArn = yield* queue.jobQueueArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${queue}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: options.wildcardIam
                  ? ["*"]
                  : [Output.interpolate`${queue.jobQueueArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${queue.LogicalId})`)(function* (
        request?: Omit<I, "jobQueue">,
      ) {
        return yield* op({
          ...request,
          jobQueue: yield* JobQueueArn,
        } as I);
      });
    });
  });
