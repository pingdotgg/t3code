import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";
import { LinkNotFound } from "./Links.ts";

export const LinkView = Schema.Struct({
  code: Schema.String,
  url: Schema.String,
  createdAt: Schema.Number,
  preview: Schema.optional(Schema.Struct({ title: Schema.String, fetchedAt: Schema.Number })),
  clicks: Schema.Number,
});
export type LinkView = typeof LinkView.Type;

const Code = Schema.Struct({ code: Schema.String });

export class LinksGroup extends HttpApiGroup.make("links")
  .add(
    HttpApiEndpoint.post("create", "/links", {
      payload: Schema.Struct({ url: Schema.String }),
      success: LinkView,
    }),
  )
  .add(
    HttpApiEndpoint.post("import", "/links/import", {
      payload: Schema.Struct({ urls: Schema.Array(Schema.String) }),
      success: Schema.Array(LinkView),
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/links", {
      success: Schema.Array(LinkView),
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/links/:code", {
      params: Code,
      success: LinkView,
      error: LinkNotFound,
    }),
  ) {}

/** The public API: imported by the Worker to serve it and by the dashboard to call it. */
export class ShortyApi extends HttpApi.make("ShortyApi").add(LinksGroup) {}
