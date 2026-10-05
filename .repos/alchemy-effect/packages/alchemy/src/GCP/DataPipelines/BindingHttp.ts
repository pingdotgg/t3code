import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type { Pipeline } from "./Pipeline.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Data Pipelines bindings.
 * NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer construction
 * (after providing Credentials + HttpClient) so the inner runtime Effect is
 * `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makePipelineHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
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
    return Effect.fn(function* (pipeline: Pipeline) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: pipeline,
        iam: [grantFor(options.iam, pipeline.name)],
      });
      const name = yield* pipeline.name;
      return Effect.fn(`${options.tag}(${pipeline.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        const pipelineName = yield* name;
        return yield* run({
          ...(request ?? {}),
          name: pipelineName,
        } as I);
      });
    });
  });
