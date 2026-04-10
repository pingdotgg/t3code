import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ServerAuthPolicyShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
}

export class ServerAuthPolicy extends Context.Service<ServerAuthPolicy, ServerAuthPolicyShape>()(
  "t3/auth/Services/ServerAuthPolicy",
) {}
