/**
 * Shared scaffolding for the S3 Vectors data-plane HTTP bindings.
 *
 * NOT exported from `index.ts` — the per-level `Vectors{Read,Write,}Http.ts`
 * layers are thin compositions over this builder. Everything except the
 * distilled operations and the IAM action set is boilerplate:
 *
 * - the deploy-time half registers `Allow(host, AWS.S3Vectors.{name}(index))`
 *   with the requested actions on exactly the bound index's ARN;
 * - the runtime client methods inject the resolved `indexArn` into each
 *   distilled request.
 */
import * as s3vectors from "@distilled.cloud/aws/s3vectors";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Index } from "./VectorIndex.ts";
import type {
  GetVectorsRequest,
  ListVectorsRequest,
  QueryVectorsRequest,
  ReadVectorsClient,
} from "./VectorsRead.ts";
import type {
  DeleteVectorsRequest,
  PutVectorsRequest,
  WriteVectorsClient,
} from "./VectorsWrite.ts";

/** IAM actions granted by the read-level binding. */
export const readVectorsActions = [
  "s3vectors:QueryVectors",
  "s3vectors:GetVectors",
  "s3vectors:ListVectors",
] as const;

/** IAM actions granted by the write-level binding. */
export const writeVectorsActions = [
  "s3vectors:PutVectors",
  "s3vectors:DeleteVectors",
] as const;

/**
 * Build the shared body of an S3 Vectors data-plane `*Http` binding layer:
 * resolve the distilled operations once at layer construction (via
 * `makeClient`), register the least-privilege IAM statement on the host
 * Function at deploy time, and hand the per-index `indexArn` resolver to the
 * capability-specific client builder.
 */
export const makeVectorsHttpBinding = <Client, R>(options: {
  /** Capability name in the binding SID + trace spans, e.g. `"VectorsRead"`. */
  name: string;
  /** IAM actions granted on the bound index's ARN. */
  actions: readonly string[];
  /** Layer-scoped builder of the per-index typed runtime client. */
  makeClient: Effect.Effect<
    (indexArn: Effect.Effect<string>, label: string) => Client,
    never,
    R
  >;
}) =>
  Effect.gen(function* () {
    const makeClient = yield* options.makeClient;

    return Effect.fn(function* <I extends Index>(index: I) {
      const IndexArn = yield* index.indexArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.S3Vectors.${options.name}(${index}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [index.indexArn],
                },
              ],
            },
          );
        }
      }
      return makeClient(
        IndexArn,
        `AWS.S3Vectors.${options.name}(${index.LogicalId})`,
      );
    });
  });

/** Layer-scoped builder of the read-level {@link ReadVectorsClient}. */
export const makeReadVectorsClient = Effect.gen(function* () {
  const queryVectors = yield* s3vectors.queryVectors;
  const getVectors = yield* s3vectors.getVectors;
  const listVectors = yield* s3vectors.listVectors;

  return (
    IndexArn: Effect.Effect<string>,
    label: string,
  ): ReadVectorsClient => ({
    query: Effect.fn(`${label}.query`)(function* (
      request: QueryVectorsRequest,
    ) {
      const indexArn = yield* IndexArn;
      return yield* queryVectors({ ...request, indexArn });
    }),
    get: Effect.fn(`${label}.get`)(function* (request: GetVectorsRequest) {
      const indexArn = yield* IndexArn;
      return yield* getVectors({ ...request, indexArn });
    }),
    list: Effect.fn(`${label}.list`)(function* (request: ListVectorsRequest) {
      const indexArn = yield* IndexArn;
      return yield* listVectors({ ...request, indexArn });
    }),
  });
});

/** Layer-scoped builder of the write-level {@link WriteVectorsClient}. */
export const makeWriteVectorsClient = Effect.gen(function* () {
  const putVectors = yield* s3vectors.putVectors;
  const deleteVectors = yield* s3vectors.deleteVectors;

  return (
    IndexArn: Effect.Effect<string>,
    label: string,
  ): WriteVectorsClient => ({
    put: Effect.fn(`${label}.put`)(function* (request: PutVectorsRequest) {
      const indexArn = yield* IndexArn;
      return yield* putVectors({ ...request, indexArn });
    }),
    delete: Effect.fn(`${label}.delete`)(function* (
      request: DeleteVectorsRequest,
    ) {
      const indexArn = yield* IndexArn;
      return yield* deleteVectors({ ...request, indexArn });
    }),
  });
});
