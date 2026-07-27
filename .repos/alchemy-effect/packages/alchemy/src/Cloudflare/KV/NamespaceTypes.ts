import * as Data from "effect/Data";

export class NamespaceError extends Data.TaggedError("NamespaceError")<{
  message: string;
  cause: Error;
}> {}
