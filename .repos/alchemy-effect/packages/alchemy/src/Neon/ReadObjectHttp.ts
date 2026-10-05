import * as Layer from "effect/Layer";
import { ReadObject } from "./ReadObject.ts";
import { storageHttpLayer } from "./StorageBinding.ts";
import { makeReadObjectHttp } from "./StorageObjectBinding.ts";

/**
 * Typed object reads using injected or automatically scoped credentials.
 *
 * @layer
 * @product Bucket
 * @provides ReadObject
 */
export const ReadObjectHttp = Layer.effect(
  ReadObject,
  makeReadObjectHttp(),
).pipe(Layer.provide(storageHttpLayer));
