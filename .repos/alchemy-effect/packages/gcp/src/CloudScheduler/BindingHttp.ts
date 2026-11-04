import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type BindingIam } from "../HttpBinding.ts";
import type { Job } from "./Job.ts";

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
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (job: Job) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${job})`({ iam: [grantFor(options.iam, job.name)] });
      }
      const name = yield* job.name;
      return Effect.fn(`${options.tag}(${job.LogicalId})`)(function* (request?: Omit<I, "name">) {
        const jobName = yield* name;
        return yield* run({
          ...request,
          name: jobName,
        } as I);
      });
    });
  });
