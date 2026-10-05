import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { User } from "./current-user.ts";
import { Authentication } from "./middleware.ts";

export class Public extends HttpApiGroup.make("public").add(
  HttpApiEndpoint.get("health", "/api/health", {
    success: Schema.Struct({ ok: Schema.Literal(true) }),
  }),
  HttpApiEndpoint.get("providers", "/api/providers", {
    success: Schema.Struct({ github: Schema.Boolean }),
  }),
) {}

export class Private extends HttpApiGroup.make("private")
  .add(HttpApiEndpoint.get("me", "/api/me", { success: User }))
  .middleware(Authentication) {}

export class Api extends HttpApi.make("app").add(Public, Private) {}
