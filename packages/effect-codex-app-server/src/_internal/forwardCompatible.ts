import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Wire codec for server→client string enums that carry a serde catch-all
 * member. The running codex binary can emit members newer than the pinned
 * protocol schema (e.g. a plan type added in a later codex release), and
 * upstream folds those into the catch-all via `#[serde(other)]`. Mirror that
 * here so a newer server cannot fail the decode of an entire payload over a
 * member the client could not have acted on anyway. Encoding is the plain
 * string encoding.
 */
export const ForwardCompatibleLiterals = <const Members extends ReadonlyArray<string>>(
  members: Members,
  fallback: Members[number],
) => {
  const known = new Set<string>(members);
  return Schema.String.pipe(
    Schema.decodeTo(
      Schema.Literals(members),
      SchemaTransformation.transform<Members[number], string>({
        decode: (value) => (known.has(value) ? (value as Members[number]) : fallback),
        encode: (value) => value,
      }),
    ),
  );
};
