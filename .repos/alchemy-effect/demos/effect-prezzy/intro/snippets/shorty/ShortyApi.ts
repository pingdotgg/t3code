import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";
import { Link, LinkNotFound } from "./Link.ts";

// #region show
// #region endpoints
const createLink = HttpApiEndpoint.post("create", "/links", {
  payload: Schema.Struct({ url: Schema.String }),
  success: Link,
});
// #region get

const getLink = HttpApiEndpoint.get("get", "/links/:code", {
  params: Schema.Struct({ code: Schema.String }),
  success: Link,
  // #region getError
  error: LinkNotFound,
  // #endregion getError
});
// #endregion get
// #region list

const listLinks = HttpApiEndpoint.get("list", "/links", {
  success: Schema.Array(Link),
});
// #endregion list
// #endregion endpoints
// #region api

export class ShortyApi extends HttpApi.make("ShortyApi").add(
  HttpApiGroup.make("links").add(createLink, getLink, listLinks),
) {}
// #endregion api
// #endregion show
