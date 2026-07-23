import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export { Credentials } from "@distilled.cloud/aws/Credentials";

/**
 * Lazy `Credentials` layer derived from the surrounding {@link AWSEnvironment}.
 * Credentials are resolved on first access (not during layer construction),
 * matching the existing @distilled.cloud/aws semantics.
 */
export const fromEnvironment = Layer.effect(
  Credentials,
  AWSEnvironment.useSync((env) => env.credentials),
);
