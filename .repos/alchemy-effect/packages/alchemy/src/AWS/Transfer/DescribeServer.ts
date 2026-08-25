import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Server } from "./Server.ts";

/**
 * Runtime binding for `transfer:DescribeServer`.
 *
 * Reads the bound {@link Server}'s live configuration and state — the
 * `ServerId` is injected from the binding. Useful for checking whether the
 * server is `ONLINE`/`OFFLINE` before a {@link StartServer}/{@link StopServer}
 * call or surfacing endpoint details to an admin portal. Provide the
 * implementation with `Effect.provide(AWS.Transfer.DescribeServerHttp)`.
 * @binding
 * @section Observing the Server
 * @example Read the Server State
 * ```typescript
 * // init — bind the operation to the server
 * const describeServer = yield* AWS.Transfer.DescribeServer(server);
 *
 * // runtime
 * const { Server } = yield* describeServer();
 * yield* Effect.log(`server is ${Server.State}`);
 * ```
 */
export interface DescribeServer extends Binding.Service<
  DescribeServer,
  "AWS.Transfer.DescribeServer",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: Omit<transfer.DescribeServerRequest, "ServerId">,
    ) => Effect.Effect<
      transfer.DescribeServerResponse,
      transfer.DescribeServerError
    >
  >
> {}
export const DescribeServer = Binding.Service<DescribeServer>(
  "AWS.Transfer.DescribeServer",
);
