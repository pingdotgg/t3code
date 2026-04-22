import type { ServerAuthDescriptor } from "@harness/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ServerAuthPolicyShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
}

export class ServerAuthPolicy extends Context.Service<ServerAuthPolicy, ServerAuthPolicyShape>()(
  "harness/auth/Services/ServerAuthPolicy",
) {}
