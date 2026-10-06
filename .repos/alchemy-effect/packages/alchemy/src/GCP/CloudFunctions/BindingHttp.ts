import {
  makeNamedHttpBinding,
  type BindingIam,
  type GcpHttpOp,
} from "../HttpBinding.ts";
import type { Function as CloudFunction } from "./Function.ts";

/**
 * Shared HTTP scaffolding for Cloud Functions bindings.
 * NOT exported from index.ts.
 */
export const makeFunctionHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  makeNamedHttpBinding<CloudFunction, I, A, E>({
    tag: options.tag,
    operation: options.operation,
    iam: options.iam,
    resourceName: (fn) => fn.name,
  });
