import * as Layer from "effect/Layer";
import {
  makeReadVectorsClient,
  makeVectorsHttpBinding,
  readVectorsActions,
} from "./BindingHttp.ts";
import { VectorsRead } from "./VectorsRead.ts";

/**
 * HTTP implementation of {@link VectorsRead} — calls the S3 Vectors data
 * plane with the host Function's own credentials, granting only the read
 * actions (`QueryVectors`, `GetVectors`, `ListVectors`) on the bound index.
 */
export const VectorsReadHttp = Layer.effect(
  VectorsRead,
  makeVectorsHttpBinding({
    name: "VectorsRead",
    actions: readVectorsActions,
    makeClient: makeReadVectorsClient,
  }),
);
