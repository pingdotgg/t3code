import * as Data from "effect/Data";

export class NamespaceError extends Data.TaggedError("NamespaceError")<{
  message: string;
  cause: Error;
}> {}

/** The API returned a namespace with a different storage mode. */
export class NamespaceModeMismatch extends Data.TaggedError("NamespaceModeMismatch")<{
  namespaceId: string;
  expected: "instant" | "classic";
}> {
  get message() {
    return `Namespace ${this.namespaceId} does not have the expected ${this.expected} mode`;
  }
}
