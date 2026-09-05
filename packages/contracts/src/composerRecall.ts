import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

const Whitespace = Schema.String.check(Schema.isPattern(/^\s*$/u));

/** Kept UTF-16 slices of message text. Absent means unknown; empty means no prompt. */
export const ComposerRecall = Schema.Struct({
  ranges: Schema.Array(Schema.Tuple([NonNegativeInt, NonNegativeInt])),
  leadingWhitespace: Schema.optional(Whitespace),
  trailingWhitespace: Schema.optional(Whitespace),
});
export type ComposerRecall = typeof ComposerRecall.Type;
