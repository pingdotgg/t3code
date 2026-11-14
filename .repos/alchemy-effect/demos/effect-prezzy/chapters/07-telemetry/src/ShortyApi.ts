import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";
import { Link, LinkNotFound } from "./Link.ts";

const createLink = HttpApiEndpoint.post("create", "/links", {
  payload: Schema.Struct({ url: Schema.String }),
  success: Link,
});

const listLinks = HttpApiEndpoint.get("list", "/links", {
  success: Schema.Array(Link),
});

const getLink = HttpApiEndpoint.get("get", "/links/:code", {
  params: Schema.Struct({ code: Schema.String }),
  success: Link,
  error: LinkNotFound,
});

export const LinksGroup = HttpApiGroup.make("links").add(createLink).add(listLinks).add(getLink);

/** One value: served by the Worker, called by the dashboard and the tests. */
export class ShortyApi extends HttpApi.make("ShortyApi").add(LinksGroup) {}
