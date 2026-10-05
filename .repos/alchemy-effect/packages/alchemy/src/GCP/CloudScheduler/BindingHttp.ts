import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type { Job } from "./Job.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Cloud Scheduler job bindings.
 * NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer construction
 * (after providing Credentials + HttpClient) so the inner runtime Effect is
 * `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makeJobHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: Effect.Effect<
    (input: I) => Effect.Effect<A, E>,
    never,
    Credentials | HttpClient.HttpClient
  > &
    ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (job: Job) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: job,
        iam: [grantFor(options.iam, job.name)],
      });
      const name = yield* job.name;
      return Effect.fn(`${options.tag}(${job.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        const jobName = yield* name;
        return yield* run({
          ...(request ?? {}),
          name: jobName,
        } as I);
      });
    });
  });
