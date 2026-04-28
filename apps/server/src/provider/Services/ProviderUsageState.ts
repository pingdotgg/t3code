import type { ProviderKind, ServerProviderUsageLimits, ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProviderUsageStateShape {
  readonly get: (provider: ProviderKind) => Effect.Effect<ServerProviderUsageLimits | undefined>;
  readonly set: (
    provider: ProviderKind,
    threadId: ThreadId,
    usage: ServerProviderUsageLimits | undefined,
  ) => Effect.Effect<void>;
  readonly clear: (provider: ProviderKind) => Effect.Effect<void>;
}

export class ProviderUsageState extends Context.Service<
  ProviderUsageState,
  ProviderUsageStateShape
>()("t3/provider/Services/ProviderUsageState") {}
