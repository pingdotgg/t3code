import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

export class Greeting extends Schema.Class<Greeting>("Greeting")({
  message: Schema.String,
}) {}

export const hello = HttpApiEndpoint.get("hello", "/", {
  success: Greeting,
});

export class HelloGroup extends HttpApiGroup.make("Hello").add(hello) {}

export class BackendApi extends HttpApi.make("BackendApi").add(HelloGroup) {}
