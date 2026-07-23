import * as Context from "effect/Context";

export class Request extends Context.Service<Request, globalThis.Request>()(
  "Request",
) {}
