import * as Layer from "effect/Layer";
import { WriteObject } from "./WriteObject.ts";
import { storageHttpLayer } from "./StorageBinding.ts";
import { makeWriteObjectHttp } from "./StorageObjectBinding.ts";

/**
 * Typed object writes using injected or automatically scoped credentials.
 *
 * @layer
 * @product Bucket
 * @provides WriteObject
 */
export const WriteObjectHttp = Layer.effect(
  WriteObject,
  makeWriteObjectHttp(),
).pipe(Layer.provide(storageHttpLayer));
