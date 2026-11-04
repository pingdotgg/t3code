import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Schema from "effect/Schema";

/** Record schema shared by the Pipelines stream fixtures and tests. */
export class PageView extends Schema.Class<PageView>("PageView")({
  url: Schema.String,
  at: Schema.Date,
  tags: Schema.Array(Schema.String),
  user: Schema.optional(Schema.Struct({ id: Schema.String })),
}) {}

/** The field list `PageView` converts to — equivalent spelling. */
export const pageViewFields: Cloudflare.Pipelines.StreamField[] = [
  { type: "string", name: "url", required: true },
  { type: "timestamp", name: "at", required: true },
  { type: "list", name: "tags", required: true, items: { type: "string" } },
  {
    type: "struct",
    name: "user",
    required: false,
    fields: [{ type: "string", name: "id", required: true }],
  },
];

/** Typed, authenticated-HTTP stream used by the producer fixtures. */
export const PageViews = Cloudflare.Basin.Stream("PageViews", {
  schema: PageView,
  http: true,
});
