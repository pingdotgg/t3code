import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, grantFor } from "../HttpBinding.ts";
import type { TransferJob } from "./TransferJob.ts";

/**
 * Shared HTTP scaffolding for Storage Transfer job bindings.
 * NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer construction
 * (after providing Credentials + HttpClient) so the inner runtime Effect is
 * `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makeTransferJobHttpBinding = <I extends { jobName?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: Effect.Effect<
    (input: I) => Effect.Effect<A, E>,
    never,
    Credentials | HttpClient.HttpClient
  > &
    ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);
  projectInBody?: boolean;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (job: TransferJob) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${job})`({ iam: [grantFor(options.iam, job.name)] });
      }
      const name = yield* job.name;
      const project = yield* job.project;
      return Effect.fn(`${options.tag}(${job.LogicalId})`)(function* (
        request?: Omit<I, "jobName">,
      ) {
        const jobName = yield* name;
        const projectId = yield* project;
        const input = {
          ...request,
          jobName,
        } as I;
        if (options.projectInBody) {
          const withBody = input as I & {
            body?: { projectId?: string };
          };
          withBody.body = {
            ...withBody.body,
            projectId: withBody.body?.projectId ?? projectId,
          };
        }
        return yield* run(input);
      });
    });
  });
