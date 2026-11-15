import * as Schema from "effect/Schema";

export function lazySchemaEquivalence<T>(schema: Schema.Schema<T>) {
  let equivalence: ((left: T, right: T) => boolean) | undefined;
  return (left: T, right: T): boolean =>
    left === right || (equivalence ??= Schema.toEquivalence(schema))(left, right);
}
