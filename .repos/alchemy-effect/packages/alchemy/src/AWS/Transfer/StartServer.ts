import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Server } from "./Server.ts";

/**
 * Runtime binding for `transfer:StartServer`.
 *
 * Brings a stopped {@link Server} from `OFFLINE` back to `ONLINE` so it can
 * accept file transfers again — the `ServerId` is injected from the binding.
 * Paired with {@link StopServer} this enables runtime schedules that park
 * the endpoint outside business hours. The call is asynchronous: the server
 * passes through `STARTING`; observe progress with {@link DescribeServer}.
 * Starting a server that is not `OFFLINE` fails with the typed
 * `InvalidRequestException`. Provide the implementation with
 * `Effect.provide(AWS.Transfer.StartServerHttp)`.
 * @binding
 * @section Controlling Server Availability
 * @example Bring the Server Online
 * ```typescript
 * // init — bind the operation to the server
 * const startServer = yield* AWS.Transfer.StartServer(server);
 *
 * // runtime
 * yield* startServer();
 * ```
 */
export interface StartServer extends Binding.Service<
  StartServer,
  "AWS.Transfer.StartServer",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: Omit<transfer.StartServerRequest, "ServerId">,
    ) => Effect.Effect<transfer.StartServerResponse, transfer.StartServerError>
  >
> {}
export const StartServer = Binding.Service<StartServer>(
  "AWS.Transfer.StartServer",
);
