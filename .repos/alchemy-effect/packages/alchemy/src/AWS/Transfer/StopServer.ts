import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Server } from "./Server.ts";

/**
 * Runtime binding for `transfer:StopServer`.
 *
 * Takes the bound {@link Server} from `ONLINE` to `OFFLINE` so it stops
 * accepting file transfers — the `ServerId` is injected from the binding.
 * Server and user configuration are unaffected. Note stopping does NOT
 * pause billing; only deleting the server does. The call is asynchronous:
 * the server passes through `STOPPING`; observe progress with
 * {@link DescribeServer}. Stopping a server that is not `ONLINE` fails with
 * the typed `InvalidRequestException`. Provide the implementation with
 * `Effect.provide(AWS.Transfer.StopServerHttp)`.
 * @binding
 * @section Controlling Server Availability
 * @example Take the Server Offline
 * ```typescript
 * // init — bind the operation to the server
 * const stopServer = yield* AWS.Transfer.StopServer(server);
 *
 * // runtime
 * yield* stopServer();
 * ```
 */
export interface StopServer extends Binding.Service<
  StopServer,
  "AWS.Transfer.StopServer",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: Omit<transfer.StopServerRequest, "ServerId">,
    ) => Effect.Effect<transfer.StopServerResponse, transfer.StopServerError>
  >
> {}
export const StopServer = Binding.Service<StopServer>(
  "AWS.Transfer.StopServer",
);
