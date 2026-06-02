import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

// Top level groups are added to the root of the derived HttpApiClient.
//
// `client.health()`
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", {
    success: HttpApiSchema.NoContent
  })
) {}
