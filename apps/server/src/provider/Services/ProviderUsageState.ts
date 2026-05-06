import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUsageLimits,
  ThreadId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProviderUsageStateShape {
  readonly get: (
    provider: ProviderDriverKind,
    providerInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<ServerProviderUsageLimits | undefined>;
  readonly set: (
    provider: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId | undefined,
    threadId: ThreadId,
    usage: ServerProviderUsageLimits | undefined,
  ) => Effect.Effect<void>;
  readonly clear: (
    provider: ProviderDriverKind,
    providerInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<void>;
}

export class ProviderUsageState extends Context.Service<
  ProviderUsageState,
  ProviderUsageStateShape
>()("t3/provider/Services/ProviderUsageState") {}
