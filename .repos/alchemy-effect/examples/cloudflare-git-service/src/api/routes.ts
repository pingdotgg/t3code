/** The app's own Effect HTTP endpoints. */
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Unauthorized, User } from "./auth.ts";

/** Who am I. Signed-in only. */
export const Me = HttpApiEndpoint.get("me", "/api/v1/me", {
  success: User,
  error: Unauthorized,
});

export class AppRoutes extends HttpApiGroup.make("app").add(Me) {}
