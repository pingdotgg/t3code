import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeReadVectorsClient,
  makeVectorsHttpBinding,
  makeWriteVectorsClient,
  readVectorsActions,
  writeVectorsActions,
} from "./BindingHttp.ts";
import { type VectorsClient, Vectors } from "./Vectors.ts";

/**
 * HTTP implementation of {@link Vectors} — calls the S3 Vectors data plane
 * with the host Function's own credentials, granting the full read+write
 * action set on the bound index. Composes the read- and write-level client
 * builders.
 */
export const VectorsHttp = Layer.effect(
  Vectors,
  makeVectorsHttpBinding({
    name: "Vectors",
    actions: [...readVectorsActions, ...writeVectorsActions],
    makeClient: Effect.gen(function* () {
      const makeRead = yield* makeReadVectorsClient;
      const makeWrite = yield* makeWriteVectorsClient;
      return (
        indexArn: Effect.Effect<string>,
        label: string,
      ): VectorsClient => ({
        ...makeRead(indexArn, label),
        ...makeWrite(indexArn, label),
      });
    }),
  }),
);
