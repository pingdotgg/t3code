import * as Context from "effect/Context";
import type { Scope } from "effect/Scope";

/**
 * The context of an execution in the runtime.
 *
 * E.g. the context of a request/event being handled in a Worker or Lambda Function.
 * E.g. in a serverful environment, it has the lifetime of the whole runtime.
 */
export class ExecutionContext extends Context.Service<
  ExecutionContext,
  {
    scope: Scope;
    cache: {
      [key: symbol | string]: any;
    };
  }
>()("ExecutionContext") {}
