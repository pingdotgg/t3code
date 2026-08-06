import * as Schema from "effect/Schema";

/** Built-in labels available for lightweight thread organization. */
export const ThreadLabel = Schema.Literals(["bug", "feature", "review", "new-build"]);
export type ThreadLabel = typeof ThreadLabel.Type;
